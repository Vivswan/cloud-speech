import { createStore, del, get, set, type UseStore } from "idb-keyval";
import { z } from "zod";
import { storage } from "#imports";
import type { ProviderId } from "@/providers/types";
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

export function updatePlayback(
  epoch: number,
  fn: (current: Playback) => PlaybackDraft,
): Promise<Playback | null> {
  return withLock(PLAYBACK_LOCK, async () => {
    const current = await readPlayback();
    if (current.epoch !== epoch) return null;
    return writePlayback(fn(current), epoch);
  });
}

export function patchPlaybackRate(rate: number): Promise<Playback> {
  return withLock(PLAYBACK_LOCK, async () => {
    const current = await readPlayback();
    return writePlayback({ ...current, rate }, current.epoch);
  });
}

export const AudioEventSchema = z.object({
  kind: z.enum(["progress", "ended"]),
  epoch,
  currentTime: position,
  duration: position,
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

export interface VoiceRef {
  providerId: ProviderId;
  voiceId: string;
  model: string;
}

export const previewItem = storage.defineItem<VoiceRef | null>("session:preview", {
  fallback: null,
});

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

// Losing the audio record only costs a re-synthesis on resume, so IndexedDB
// failures (quota, private mode, a blocked open) degrade to "no record".
async function bestEffort<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!audioFailureLogged) {
      audioFailureLogged = true;
      console.warn("Playback audio store unavailable; resume will re-synthesize", error);
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
  set(record: PlaybackAudio): Promise<void> {
    return bestEffort(() => set(AUDIO_KEY, record, audioStoreOrThrow()), undefined);
  },
  clear(): Promise<void> {
    return bestEffort(() => del(AUDIO_KEY, audioStoreOrThrow()), undefined);
  },
};
