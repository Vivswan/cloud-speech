import { browser } from "#imports";
import { ensureAudioHost, sendToAudioHost } from "./audio-host";
import { credentialsDigest, textDigest } from "./digest";
import { errorText } from "./error-text";
import { describeFailureWithoutCredentials, surfaceError } from "./errors";
import {
  claimPlayback,
  type Playback,
  type PlaybackDraft,
  patchPlaybackRate,
  playbackAudio,
  readPlayback,
  updatePlayback,
} from "./playback";
import type { Position } from "./protocol";
import { credentialsFor, selectionEncoding } from "./provider-state";
import { Slot } from "./slot";
import {
  clearVoiceIssue,
  getSettings,
  recordVoiceIssue,
  type Settings,
  type VoiceModelRef,
} from "./storage";
import { getAudioUri } from "./synthesize";
import { sanitizeTextForSSML } from "./text";
import { UserFacingError } from "./user-facing-error";

// Drives the audio host (lib/audio-host.ts) from the playback document
// (lib/playback.ts); the document is the only state. Every transition but the
// rate patch is a claim or a compare-and-swap on the read's epoch, and a swap
// that comes back null means the read was superseded and the work simply does
// nothing.
//
// The whole read is one merged audio file, kept in IndexedDB under the read's epoch:
//   timeline                                                -> spans the entire text
//   same text and settings again                            -> replays the record, no API call
//   resume after Chrome closed the idle offscreen document  -> replays from the parked position (about 30 s without sound closes it)

async function synthesisKey(text: string, settings: Settings): Promise<string> {
  const selection = settings.selection;
  return JSON.stringify([
    text,
    selectionEncoding(settings, "readAloud"),
    selection,
    selection && (await credentialsDigest(credentialsFor(settings, selection.providerId))),
    settings.speed,
    settings.pitch,
    settings.volumeGainDb,
  ]);
}

function idle(current: Playback): PlaybackDraft {
  return { status: "idle", rate: current.rate };
}

// A newer read or a stop cancels the in-flight synthesis instead of letting
// it finish and be paid for.
const readSlot = new Slot();

// The read's epoch cannot tell apart host commands whose continuations outlive
// their state (a `play` settles only when the audio ends or is interrupted; a
// resume's recovery can outlast a pause and a second resume), so each
// play/resume takes a number inside its locked document update and acts only
// while still the newest. In-memory on purpose: a recycled context has no
// pending commands.
let mainCommand = 0;

// MV3 self-keepalive for the synthesis window: with no audio loaded nothing
// else resets the worker's ~30 s idle timer, and any extension API call does.
// Bounded so a hung provider cannot pin the worker forever; owned by the
// read's signal, so aborting the read stops it.
let synthesisKeepalive: ReturnType<typeof setInterval> | undefined;
function startSynthesisKeepalive(signal: AbortSignal): void {
  stopSynthesisKeepalive();
  if (signal.aborted) return;
  const deadline = Date.now() + 240_000;
  synthesisKeepalive = setInterval(() => {
    if (Date.now() > deadline) {
      stopSynthesisKeepalive();
      return;
    }
    void browser.runtime.getPlatformInfo();
  }, 20_000);
  signal.addEventListener("abort", stopSynthesisKeepalive, { once: true });
}
function stopSynthesisKeepalive(): void {
  if (synthesisKeepalive !== undefined) {
    clearInterval(synthesisKeepalive);
    synthesisKeepalive = undefined;
  }
}

/** For background startup: a fresh context has no synthesis in flight.
 *
 *  status synthesizing  -> a context died mid-read; settle idle
 *  epoch 0              -> a new browser session (the document is session-scoped, the audio record is not); clear the record
 */
export async function recoverPlayback(): Promise<void> {
  const current = await readPlayback();
  if (current.epoch === 0) await playbackAudio.clear();
  if (current.status === "synthesizing") {
    await updatePlayback(current.epoch, (doc) => (doc.status === "synthesizing" ? idle(doc) : doc));
  }
}

export async function startReading(text: string, speed?: number): Promise<boolean> {
  if (!text.trim()) return false;

  // Claim the slot before any await: the previous read's synthesis is then
  // cancelled in call order, the same order the playback lock hands out
  // epochs below, so slot owner and document owner never diverge.
  const signal = readSlot.claim();
  // The rate outlives the read: 1.5x once means 1.5x until the user changes
  // it.
  const claimed = await claimPlayback((current) => ({
    status: "synthesizing",
    rate: speed ?? current.rate,
    textDigest: textDigest(text),
  }));
  startSynthesisKeepalive(signal);

  // Not stopReading(): that would claim another epoch and orphan this read.
  try {
    await ensureAudioHost();
    await sendToAudioHost("stop");
  } catch (error) {
    console.warn("Failed to prepare the audio host", error);
  }

  // Detached; failures are surfaced to the user inside.
  void synthesizeAndPlay(claimed.epoch, text, signal);
  return true;
}

async function synthesizeAndPlay(epoch: number, text: string, signal: AbortSignal): Promise<void> {
  // One settings snapshot for the cache key, the synthesis, and the issue key
  // on failure, so they can never diverge.
  let settings: Settings;
  try {
    settings = await getSettings();
  } catch (error) {
    await failRead(epoch, signal, error, null);
    return;
  }
  const issueRef = settings.selection;

  // Sanitize here, not in the callers: the document's digest is over the
  // caller's raw text, so the popup can match it against what the user typed.
  const cleanText = sanitizeTextForSSML(text);
  let key: string;
  let audioUri: string;
  try {
    key = await synthesisKey(cleanText, settings);
    const cached = await playbackAudio.get();
    if (cached?.synthesisKey === key) {
      audioUri = cached.audioUri;
    } else {
      audioUri = await getAudioUri({ text: cleanText, purpose: "readAloud", settings, signal });
      // A real synthesis success says the voice works even if this read was
      // superseded meanwhile; a cache hit says nothing about current
      // credentials, so it never clears.
      if (issueRef) await clearVoiceIssue(issueRef).catch(() => {});
    }
  } catch (error) {
    await failRead(epoch, signal, error, issueRef);
    return;
  }

  // Superseded or stopped while synthesizing: nothing of this read may sound
  // or be recorded.
  if (signal.aborted) return;
  stopSynthesisKeepalive();
  await playbackAudio.set({ epoch, synthesisKey: key, audioUri });
  await play(epoch, audioUri);
}

/** A read whose signal aborted was superseded or stopped: its failure, its
 *  own cancellation included, is nobody's news. */
async function failRead(
  epoch: number,
  signal: AbortSignal,
  error: unknown,
  issueRef: VoiceModelRef | null,
): Promise<void> {
  if (signal.aborted) return;
  stopSynthesisKeepalive();
  console.error("Synthesis failed", error);
  if (issueRef) {
    const issue = await describeFailureWithoutCredentials(error, {
      providerId: issueRef.providerId,
    });
    await recordVoiceIssue(issueRef, issue).catch(() => {});
  }
  const settled = await updatePlayback(epoch, (current) =>
    current.status === "synthesizing" ? idle(current) : current,
  );
  // The issue reference names the provider the request went to; a fetch that
  // never got an answer cannot name it itself.
  if (settled?.status === "idle") {
    await surfaceError(error, issueRef ? { providerId: issueRef.providerId } : {});
  }
}

/** Re-read after bringing the host up: creating an offscreen document takes
 *  long enough for a pause or a rate change to land meanwhile, and a pause
 *  sent while no host existed reached nothing. Null when the read no longer
 *  plays under `epoch`; no host command may then go out. */
async function hostReadyFor(
  epoch: number,
): Promise<Extract<Playback, { status: "playing" }> | null> {
  await ensureAudioHost();
  const current = await readPlayback();
  return current.status === "playing" && current.epoch === epoch ? current : null;
}

/** Resolves when the audio ends or is interrupted, so a caller answering a
 *  request runs it detached. The natural end arrives through audioEnded; this
 *  settles only the play's own failures.
 *
 *  replayFor  -> the command of a resume the host refused (the document already says playing at the parked position); dropped when a newer command took the channel by the time this locked update runs
 */
async function play(epoch: number, audioUri: string, replayFor?: number): Promise<void> {
  let command = 0;
  await updatePlayback(epoch, (current) => {
    if (current.status === "synthesizing") {
      command = ++mainCommand;
      return {
        status: "playing",
        rate: current.rate,
        textDigest: current.textDigest,
        currentTime: 0,
        duration: 0,
      };
    }
    if (current.status === "playing" && replayFor === mainCommand) command = ++mainCommand;
    return current;
  });
  if (command === 0) return;
  try {
    const current = await hostReadyFor(epoch);
    if (!current) return;
    // Rate and position come from the re-read document: a rate change or a
    // seek that landed while the host came up must not be undone here.
    await sendToAudioHost("play", {
      audioUri,
      rate: current.rate,
      epoch,
      startAt: current.currentTime,
    });
  } catch (error) {
    // Chrome closing the idle offscreen document during a pause severs the
    // pending play too; the read is parked and resume replays it. A rejection
    // after a later play or resume took the channel is that severed promise,
    // whatever the document says now.
    const settled = await updatePlayback(epoch, (current) =>
      current.status === "playing" && command === mainCommand ? idle(current) : current,
    );
    if (settled?.status === "idle") {
      console.error("Playback failed", error);
      await surfaceError(error);
    }
  }
}

export async function stopReading(): Promise<boolean> {
  readSlot.release();
  await claimPlayback((current) => (current.status === "idle" ? null : idle(current)));
  try {
    await ensureAudioHost();
    await sendToAudioHost("stop");
  } catch (error) {
    console.warn("Failed to stop audio", error);
  }
  return true;
}

export async function pause(): Promise<boolean> {
  const current = await readPlayback();
  if (current.status !== "playing") return false;
  // The document turns before the host is told: a resume racing this pause
  // re-reads the document right before its own command, so the later
  // transition decides what sounds.
  const paused = await updatePlayback(current.epoch, (doc) =>
    doc.status !== "playing"
      ? doc
      : {
          status: "paused",
          rate: doc.rate,
          textDigest: doc.textDigest,
          currentTime: doc.currentTime,
          duration: doc.duration,
        },
  );
  if (paused?.status !== "paused") return false;
  // No ensureAudioHost: with the session's context gone there is nothing to
  // pause, and the document keeps the last position it was told.
  const position = await sendToAudioHost("pause").catch(() => null);
  if (position) {
    await updatePlayback(current.epoch, (doc) =>
      doc.status === "paused" ? { ...doc, ...position } : doc,
    );
  }
  return true;
}

export async function resume(): Promise<boolean> {
  const current = await readPlayback();
  if (current.status !== "paused") return false;
  const { epoch } = current;
  let command = 0;
  await updatePlayback(epoch, (doc) => {
    if (doc.status !== "paused") return doc;
    command = ++mainCommand;
    return {
      status: "playing",
      rate: doc.rate,
      textDigest: doc.textDigest,
      // From the locked document, not the read above (a seek may have landed
      // in between). A read parked at its end starts over, like the element
      // itself does.
      currentTime: doc.currentTime < doc.duration ? doc.currentTime : 0,
      duration: doc.duration,
    };
  });
  // Not paused any more under the lock: superseded, or an earlier resume
  // already took the channel.
  if (command === 0) return false;
  let hostRefusal: string;
  try {
    if (!(await hostReadyFor(epoch))) return false;
    await sendToAudioHost("resume", { epoch });
    return true;
  } catch (hostError) {
    // The host refused, usually because its context was recycled during the
    // pause and nothing is loaded there any more: replay the recorded audio
    // from the parked position.
    hostRefusal = errorText(hostError);
  }
  const record = await playbackAudio.get();
  // A pause and a second resume may have taken the channel meanwhile; the
  // outcome of this recovery is then theirs to decide.
  if (command !== mainCommand) return false;
  if (record?.epoch === epoch) {
    // Detached: the play settles only when the audio ends or is interrupted,
    // and the caller is answering a request.
    void play(epoch, record.audioUri, command);
    return true;
  }
  const settled = await updatePlayback(epoch, (doc) =>
    doc.status === "playing" && command === mainCommand ? idle(doc) : doc,
  );
  if (settled?.status === "idle") {
    await surfaceError(
      new UserFacingError({
        titleKey: "errors.read_failed_title",
        messageKey: "errors.audio_unavailable",
        detail:
          `AudioUnavailable: the audio host could not resume epoch ${epoch} (${hostRefusal}) ` +
          `and no cached audio matches it (cached epoch: ${record?.epoch ?? "none"})`,
      }),
    );
  }
  return false;
}

export async function setRate(rate: number): Promise<boolean> {
  // Not epoch-checked on purpose: the rate is the user's preference across
  // reads, so it lands whatever the current read is doing.
  const current = await patchPlaybackRate(rate);
  try {
    await sendToAudioHost("setRate", { rate });
    return true;
  } catch {
    // No session context; the rate is in the document and applies on the
    // next play or resume.
    return current.status !== "playing";
  }
}

export async function seekTo(seconds: number): Promise<boolean> {
  const current = await readPlayback();
  if (current.status !== "playing" && current.status !== "paused") return false;
  let position: Position;
  try {
    // The session rejects when nothing is loaded and otherwise answers with
    // the element's own position (or, while it is still loading, the requested
    // target floored at 0 with duration 0; the element clamps it to the
    // duration once metadata arrives), so the document never carries a
    // phantom position.
    position = await sendToAudioHost("seekTo", { seconds });
  } catch {
    if (current.status !== "paused") return false;
    // Parked with the session's context gone: move the parked position so
    // the replay on resume starts there.
    position = {
      currentTime: Math.min(Math.max(seconds, 0), current.duration),
      duration: current.duration,
    };
  }
  const moved = await updatePlayback(current.epoch, (doc) =>
    doc.status === "playing" || doc.status === "paused"
      ? { ...doc, currentTime: position.currentTime, duration: position.duration || doc.duration }
      : doc,
  );
  return moved !== null;
}
