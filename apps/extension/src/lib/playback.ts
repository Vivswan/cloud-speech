import { createStore, del, get, set, type UseStore } from "idb-keyval";
import { z } from "zod";
import { storage } from "#imports";
import { PROVIDER_IDS } from "@/providers/types";
import { AudioPositionSchema } from "./protocol";
import { withLock } from "./storage";

// Playback state is storage-first: ONE document in `storage.session` is the
// truth, so a recycled service worker or a reopened popup reads it instead of
// rebuilding it from memory. Every write is a compare-and-swap on `epoch`:
// only `claimPlayback` advances it (a new read, a stop), and a continuation
// from an older claim (a late "ended", a throttled position tick) presents the
// epoch it started with and simply does not land. The audio bytes live in
// IndexedDB, not in this document: a 1 s position commit must not re-serialize
// megabytes of data URI, and `storage.session` caps at 10 MB. The store has
// its own Web Lock so position commits never queue behind settings writes.

const PLAYBACK_LOCK = "cloud-speech-playback";

const epoch = z.int().nonnegative();
const rate = z.number().positive();
const position = z.number().nonnegative();
const textDigest = z.string();

export const PlaybackSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("idle"), epoch, rate }),
  z.object({ status: z.literal("synthesizing"), epoch, rate, textDigest }),
  z.object({
    status: z.literal("playing"),
    epoch,
    rate,
    textDigest,
    currentTime: position,
    duration: position,
  }),
  z.object({
    status: z.literal("paused"),
    epoch,
    rate,
    textDigest,
    currentTime: position,
    duration: position,
  }),
]);

export type Playback = z.infer<typeof PlaybackSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A document minus its epoch: the store assigns that. Distributive on purpose
 *  (a plain `Omit` over a union keeps only the shared keys). */
export type PlaybackDraft = DistributiveOmit<Playback, "epoch">;

export const IDLE_PLAYBACK: Playback = { status: "idle", epoch: 0, rate: 1 };

const playbackItem = storage.defineItem<unknown>("session:playback", { fallback: null });

function parsePlayback(raw: unknown): Playback {
  const parsed = PlaybackSchema.safeParse(raw);
  return parsed.success ? parsed.data : IDLE_PLAYBACK;
}

export async function readPlayback(): Promise<Playback> {
  return parsePlayback(await playbackItem.getValue());
}

export function watchPlayback(callback: (playback: Playback) => void): () => void {
  return playbackItem.watch((raw) => callback(parsePlayback(raw)));
}

async function writePlayback(next: PlaybackDraft, epoch: number): Promise<Playback> {
  const written = PlaybackSchema.parse({ ...next, epoch });
  await playbackItem.setValue(written);
  return written;
}

/** Advance the epoch and write the draft `fn` returns for it; the ONLY way the
 *  epoch moves. A `fn` that may decline (return null) gets null back and
 *  nothing is written. */
export function claimPlayback(fn: (current: Playback) => PlaybackDraft): Promise<Playback>;
export function claimPlayback(
  fn: (current: Playback) => PlaybackDraft | null,
): Promise<Playback | null>;
export function claimPlayback(
  fn: (current: Playback) => PlaybackDraft | null,
): Promise<Playback | null> {
  return withLock(PLAYBACK_LOCK, async () => {
    const current = await readPlayback();
    const next = fn(current);
    if (next === null) return null;
    return writePlayback(next, current.epoch + 1);
  });
}

/** Compare-and-swap on `epoch`; null means the document moved on and nothing
 *  was written. Returning `current` itself from `fn` writes nothing either. */
export function updatePlayback(
  epoch: number,
  fn: (current: Playback) => PlaybackDraft,
): Promise<Playback | null> {
  return withLock(PLAYBACK_LOCK, async () => {
    const current = await readPlayback();
    if (current.epoch !== epoch) return null;
    const next = fn(current);
    if (next === current) return current;
    return writePlayback(next, epoch);
  });
}

export function patchPlaybackRate(rate: number): Promise<Playback> {
  return withLock(PLAYBACK_LOCK, async () => {
    const current = await readPlayback();
    return writePlayback({ ...current, rate }, current.epoch);
  });
}

export const AudioEventSchema = AudioPositionSchema.extend({
  kind: z.enum(["progress", "ended"]),
});

export type AudioEvent = z.infer<typeof AudioEventSchema>;

export function applyAudioEvent(event: AudioEvent): Promise<Playback | null> {
  return updatePlayback(event.epoch, (current) => {
    if (current.status !== "playing") return current;
    const { currentTime, duration } = event;
    if (event.kind === "progress") return { ...current, currentTime, duration };
    return {
      status: "paused",
      rate: current.rate,
      textDigest: current.textDigest,
      currentTime,
      duration,
    };
  });
}

/** The voice row a preview is auditioning. */
export const VoiceRefSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  voiceId: z.string(),
  model: z.string(),
});

export type VoiceRef = z.infer<typeof VoiceRefSchema>;

export function sameVoiceRef(a: VoiceRef, b: VoiceRef): boolean {
  return a.providerId === b.providerId && a.voiceId === b.voiceId && a.model === b.model;
}

export const previewItem = storage.defineItem<VoiceRef | null>("session:preview", {
  fallback: null,
});

function parsePreview(raw: unknown): VoiceRef | null {
  const parsed = VoiceRefSchema.nullable().safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function readPreview(): Promise<VoiceRef | null> {
  return parsePreview(await previewItem.getValue());
}

export function watchPreview(callback: (preview: VoiceRef | null) => void): () => void {
  return previewItem.watch((raw) => callback(parsePreview(raw)));
}

/** The merged audio of one read, keyed by the epoch that owns it, plus the
 *  synthesis parameters it answers: the same text with the same settings
 *  replays from here instead of costing another provider call. */
const PlaybackAudioSchema = z.object({
  epoch,
  synthesisKey: z.string(),
  audioUri: z.string(),
});

export type PlaybackAudio = z.infer<typeof PlaybackAudioSchema>;

const AUDIO_KEY = "current";

let audioStore: UseStore | undefined;
let audioFailureLogged = false;

function audioStoreOrThrow(): UseStore {
  audioStore ??= createStore("cloud-speech-playback", "audio");
  return audioStore;
}

// IndexedDB failures (quota, private mode, a blocked open) degrade to "no
// record": the read still plays from memory, and only a resume after the
// session's context was recycled has nothing to replay (the transport then
// reports the loss and settles idle).
async function bestEffort<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!audioFailureLogged) {
      audioFailureLogged = true;
      console.warn("Playback audio store unavailable; a recycled resume will not replay", error);
    }
    return fallback;
  }
}

export const playbackAudio = {
  get(): Promise<PlaybackAudio | null> {
    return bestEffort(async () => {
      const parsed = PlaybackAudioSchema.safeParse(await get(AUDIO_KEY, audioStoreOrThrow()));
      return parsed.success ? parsed.data : null;
    }, null);
  },
  /** A failed write also drops the previous record: a stale one would replay
   *  an OLDER read's audio under the current epoch. */
  set(record: PlaybackAudio): Promise<void> {
    return bestEffort(async () => {
      try {
        await set(AUDIO_KEY, record, audioStoreOrThrow());
      } catch (error) {
        await del(AUDIO_KEY, audioStoreOrThrow()).catch(() => {});
        throw error;
      }
    }, undefined);
  },
  clear(): Promise<void> {
    return bestEffort(() => del(AUDIO_KEY, audioStoreOrThrow()), undefined);
  },
};
