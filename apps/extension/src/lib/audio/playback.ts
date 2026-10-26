import { createStore, del, get, set, type UseStore } from "idb-keyval";
import { z } from "zod";
import { storage } from "#imports";
import { logWarning } from "../errors/log";
import { AudioPositionSchema } from "../messaging/protocol";
import { type VoiceModelRef, VoiceModelRefSchema, withLock } from "../settings/storage";

// One document in `storage.session` is the truth, so a recycled service
// worker or a reopened popup reads it instead of rebuilding it from memory.
// The audio bytes live in IndexedDB, not here: a 1 s position commit must not
// re-serialize megabytes of data URI, and `storage.session` caps at 10 MB.

// Its own lock, so position commits never queue behind settings writes.
const PLAYBACK_LOCK = "cloud-speech-playback";

// Moves only through claimPlayback; updatePlayback refuses a write stamped with any other.
const epoch = z.int().nonnegative();

// The mini-player's live rate, a multiplier on the synthesized speed.
const rate = z.number().positive();

// Seconds, for currentTime and duration alike.
const position = z.number().nonnegative();

// Digest of the raw text, the read's identity for the popup; the text itself never enters the document.
const textDigest = z.string();

// Counts the read's play/resume commands; a continuation acts only while the document still carries its number.
const command = z.int().positive();

// The session document; a raw value that fails to parse reads as idle.
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
    command,
  }),
  z.object({
    status: z.literal("paused"),
    epoch,
    rate,
    textDigest,
    currentTime: position,
    duration: position,
    command,
  }),
]);

export type Playback = z.infer<typeof PlaybackSchema>;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Distributive on purpose: a plain `Omit` over a union keeps only the
 *  shared keys. */
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

/** Under the lock, once a write landed: for state that moves with the document (the read slot in
 *  lib/messaging/transport.ts), so a refused write leaves it as it was. */
type OnWritten = (written: Playback) => void;

/** The ONLY way the epoch moves. A `fn` that declines (null) gets null back
 *  and nothing is written. */
export function claimPlayback(
  fn: (current: Playback) => PlaybackDraft,
  onWritten?: OnWritten,
): Promise<Playback>;
export function claimPlayback(
  fn: (current: Playback) => PlaybackDraft | null,
  onWritten?: OnWritten,
): Promise<Playback | null>;
export function claimPlayback(
  fn: (current: Playback) => PlaybackDraft | null,
  onWritten?: OnWritten,
): Promise<Playback | null> {
  return withLock(PLAYBACK_LOCK, async () => {
    const current = await readPlayback();
    const next = fn(current);
    if (next === null) return null;
    const written = await writePlayback(next, current.epoch + 1);
    onWritten?.(written);
    return written;
  });
}

/** Compare-and-swap on `epoch`; null means the document moved on and nothing
 *  was written. Returning `current` itself from `fn` writes nothing either. */
export function updatePlayback(
  epoch: number,
  fn: (current: Playback) => PlaybackDraft,
  onWritten?: OnWritten,
): Promise<Playback | null> {
  return withLock(PLAYBACK_LOCK, async () => {
    const current = await readPlayback();
    if (current.epoch !== epoch) return null;
    const next = fn(current);
    if (next === current) return current;
    const written = await writePlayback(next, epoch);
    onWritten?.(written);
    return written;
  });
}

export function patchPlaybackRate(rate: number): Promise<Playback> {
  return withLock(PLAYBACK_LOCK, async () => {
    const current = await readPlayback();
    return writePlayback({ ...current, rate }, current.epoch);
  });
}

const AudioEventSchema = AudioPositionSchema.extend({
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
      command: current.command,
    };
  });
}

export function sameVoiceModelRef(a: VoiceModelRef, b: VoiceModelRef): boolean {
  return a.providerId === b.providerId && a.voiceId === b.voiceId && a.model === b.model;
}

/** The voice row a preview is auditioning. */
export const previewItem = storage.defineItem<VoiceModelRef | null>("session:preview", {
  fallback: null,
});

function parsePreview(raw: unknown): VoiceModelRef | null {
  const parsed = VoiceModelRefSchema.nullable().safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export async function readPreview(): Promise<VoiceModelRef | null> {
  return parsePreview(await previewItem.getValue());
}

export function watchPreview(callback: (preview: VoiceModelRef | null) => void): () => void {
  return previewItem.watch((raw) => callback(parsePreview(raw)));
}

/** The same text with the same settings (synthesisKey) replays from here instead of costing another provider call. */
const PlaybackAudioSchema = z.object({
  epoch,
  synthesisKey: z.string(),
  audioUri: z.string(),
});

export type PlaybackAudio = z.infer<typeof PlaybackAudioSchema>;

/** The store holds one record, the current read's audio. */
const AUDIO_KEY = "current";

/** Its own lock, so a multi-megabyte write never holds up a position commit. */
const AUDIO_LOCK = "cloud-speech-playback-audio";

let audioStore: UseStore | undefined;
let audioFailureLogged = false;

function audioStoreOrThrow(): UseStore {
  audioStore ??= createStore("cloud-speech-playback", "audio");
  return audioStore;
}

// IndexedDB failures (quota, private mode, a blocked open) read as no record:
// the read still plays from memory, and a resume the host refuses has nothing
// to replay.
async function bestEffort<T>(operation: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!audioFailureLogged) {
      audioFailureLogged = true;
      logWarning("Playback audio store unavailable; a recycled resume will not replay", error);
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
    return bestEffort(
      () =>
        withLock(AUDIO_LOCK, async () => {
          // The lock also orders a newer read's write after a failing write's cleanup, never inside it.
          try {
            await set(AUDIO_KEY, record, audioStoreOrThrow());
          } catch (error) {
            await del(AUDIO_KEY, audioStoreOrThrow()).catch(() => {});
            throw error;
          }
        }),
      undefined,
    );
  },
  clear(): Promise<void> {
    return bestEffort(
      () => withLock(AUDIO_LOCK, () => del(AUDIO_KEY, audioStoreOrThrow())),
      undefined,
    );
  },
};
