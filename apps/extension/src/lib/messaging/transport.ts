import { browser } from "#imports";
import { ensureAudioHost, sendToAudioHost } from "../audio/audio-host";
import {
  claimPlayback,
  type Playback,
  type PlaybackDraft,
  patchPlaybackRate,
  playbackAudio,
  readPlayback,
  updatePlayback,
} from "../audio/playback";
import { getAudioUri } from "../audio/synthesize";
import { errorText } from "../errors/error-text";
import {
  describeFailureWithoutCredentials,
  type FailureContext,
  surfaceError,
} from "../errors/errors";
import { logError, logWarning } from "../errors/log";
import { UserFacingError } from "../errors/user-facing-error";
import { credentialsFor, selectionEncoding } from "../settings/provider-state";
import {
  clearVoiceIssue,
  getSettings,
  recordVoiceIssue,
  type Settings,
  type VoiceModelRef,
} from "../settings/storage";
import { credentialsDigest, textDigest } from "../text/digest";
import { sanitizeTextForSSML } from "../text/text";
import type { PayloadArgs, Position, RouteId } from "./protocol";
import { Slot } from "./slot";

// Drives the audio host (lib/audio/audio-host.ts) from the playback document
// (lib/audio/playback.ts); the document is the only state. Every transition but the
// rate patch is a claim or a compare-and-swap on the read's epoch, and what
// follows a host command also swaps on the document's command number, so a
// swap that declines means the work was superseded and simply does nothing.
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

type Playing = Extract<Playback, { status: "playing" }>;

/** The read still plays under this host command: no pause, stop, newer read,
 *  or later resume has moved it on. */
function runsUnder(current: Playback, epoch: number, command: number): current is Playing {
  return current.status === "playing" && current.epoch === epoch && current.command === command;
}

/** A read continuation's licence to act after an await: every document write, host command, and
 *  notice of a read goes through here and happens only while the read still owns the document.
 *
 *  owns   -> signal not aborted (no stop, newer read, or later resume), document under this epoch, synthesizing or playing under this command
 *  writes -> decided under the document lock (lib/audio/playback.ts), so a stop during an earlier await is still a stop
 */
class ReadLease {
  constructor(
    readonly epoch: number,
    readonly command: number,
    readonly signal: AbortSignal,
  ) {}

  owns(current: Playback): boolean {
    if (this.signal.aborted || current.epoch !== this.epoch) return false;
    return current.status === "synthesizing" || runsUnder(current, this.epoch, this.command);
  }

  async transition(fn: (current: Playback) => PlaybackDraft): Promise<Playback | null> {
    let owned = false;
    let written: Playback | null;
    try {
      written = await updatePlayback(this.epoch, (current) => {
        owned = this.owns(current);
        return owned ? fn(current) : current;
      });
    } catch (error) {
      // Storage refusing a read that is already over is nobody's news either; a live read's
      // refusal is its caller's to report.
      if (this.signal.aborted) return null;
      throw error;
    }
    return owned ? written : null;
  }

  /** An already idle read is not owned, so of two continuations settling one read, only the first
   *  gets to report. */
  async settleIdle(): Promise<boolean> {
    return (await this.transition(idle)) !== null;
  }

  /** Re-read after bringing the host up: creating an offscreen document takes long enough for a
   *  pause, a rate change, a stop, or a resume to land meanwhile, and a pause sent while no host
   *  existed reached nothing. Null when the read no longer plays under this command; nothing may
   *  then go to the host. */
  async hostReady(): Promise<Playing | null> {
    await ensureAudioHost();
    // Under the lock, not a plain read: a stop that already wrote is then always seen, whatever
    // order storage answers in.
    const current = await this.transition((doc) => doc);
    return current?.status === "playing" ? current : null;
  }

  /** A host command, checked and sent in the same tick: a stop queued between the host re-read
   *  and the send still wins. */
  tellHost<K extends RouteId<"audio">>(id: K, ...args: PayloadArgs<"audio", K>): Promise<unknown> {
    if (this.signal.aborted) return Promise.resolve();
    return sendToAudioHost(id, ...args);
  }

  /** The failure's log line and notice, unless the read was stopped or superseded meanwhile (its
   *  own cancellation included): then it is nobody's news. */
  async report(label: string, error: unknown, context: FailureContext = {}): Promise<void> {
    // Through the lock first: a stop queued behind the idle write has then released the slot.
    await this.transition((doc) => doc);
    if (this.signal.aborted) return;
    logError(label, error);
    await surfaceError(error, context, this.signal);
  }
}

/** A newer read or a stop cancels the in-flight synthesis instead of letting it finish and be paid for. */
const readSlot = new Slot();

/** Claims the slot under the document lock, once the write handing the read the document has landed:
 *  a refused write leaves the read that holds it whole, and signals and epochs come out in one order. */
async function claimRead(draft: (current: Playback) => PlaybackDraft): Promise<ReadLease> {
  let signal: AbortSignal | undefined;
  const claimed = await claimPlayback(draft, () => {
    signal = readSlot.claim().signal;
  });
  if (!signal) throw new Error("claimPlayback resolved without its write landing");
  // The play that ends the synthesis is host command 1 (lib/audio/playback.ts).
  return new ReadLease(claimed.epoch, 1, signal);
}

/** A continuation nobody awaits (the caller is answering a request). Its own failure handling
 *  settles the document and surfaces the error; when that recovery write is refused too, the
 *  log line is the last resort, never an unhandled rejection. */
function detach(continuation: Promise<void>, label: string): void {
  continuation.catch((error) => logError(label, error));
}

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

  // The rate outlives the read: 1.5x once means 1.5x until the user changes
  // it.
  const lease = await claimRead((current) => ({
    status: "synthesizing",
    rate: speed ?? current.rate,
    textDigest: textDigest(text),
  }));
  startSynthesisKeepalive(lease.signal);

  // Not stopReading(): that would claim another epoch and orphan this read.
  try {
    await ensureAudioHost();
    await lease.tellHost("stop");
  } catch (error) {
    logWarning("Failed to prepare the audio host", error);
  }

  detach(synthesizeAndPlay(lease, text), "Read continuation failed");
  return true;
}

async function synthesizeAndPlay(lease: ReadLease, text: string): Promise<void> {
  const { epoch, signal } = lease;
  // One settings snapshot for the cache key, the synthesis, and the issue key
  // on failure, so they can never diverge.
  let settings: Settings;
  try {
    settings = await getSettings();
  } catch (error) {
    await failRead(lease, error, null);
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
    await failRead(lease, error, issueRef);
    return;
  }

  // Superseded or stopped while synthesizing: nothing of this read may sound
  // or be recorded.
  if (signal.aborted) return;
  stopSynthesisKeepalive();
  await playbackAudio.set({ epoch, synthesisKey: key, audioUri });
  await play(lease, audioUri);
}

async function failRead(
  lease: ReadLease,
  error: unknown,
  issueRef: VoiceModelRef | null,
): Promise<void> {
  if (lease.signal.aborted) return;
  stopSynthesisKeepalive();
  // The issue reference names the provider the request went to; a fetch that
  // never got an answer cannot name it itself.
  if (issueRef) {
    const issue = await describeFailureWithoutCredentials(error, {
      providerId: issueRef.providerId,
    });
    await recordVoiceIssue(issueRef, issue).catch(() => {});
  }
  if (await lease.settleIdle()) {
    await lease.report(
      "Synthesis failed",
      error,
      issueRef ? { providerId: issueRef.providerId } : {},
    );
  }
}

/** Resolves when the audio ends or is interrupted, so a caller answering a
 *  request runs it detached. The natural end arrives through audioEnded; this
 *  settles only the play's own failures. */
async function play(lease: ReadLease, audioUri: string): Promise<void> {
  const { epoch, command } = lease;
  try {
    const playing = await lease.transition((current) =>
      current.status === "synthesizing"
        ? {
            status: "playing",
            rate: current.rate,
            textDigest: current.textDigest,
            currentTime: 0,
            duration: 0,
            command,
          }
        : current,
    );
    if (!playing) return;
    const current = await lease.hostReady();
    if (!current) return;
    // Rate and position come from the re-read document: a rate change or a
    // seek that landed while the host came up must not be undone here.
    await lease.tellHost("play", {
      audioUri,
      rate: current.rate,
      epoch,
      startAt: current.currentTime,
    });
  } catch (error) {
    // Chrome closing the idle offscreen document during a pause severs the
    // pending play too; the read is parked and resume replays it.
    if (await lease.settleIdle()) await lease.report("Playback failed", error);
  }
}

/** Releases the slot under the document lock, before the stop's write: a stop wins even when its
 *  read or write is refused, and even when the document is already idle and a resume's recovery
 *  that settled it is still waiting to report. */
export async function stopReading(): Promise<boolean> {
  try {
    await claimPlayback((current) => {
      readSlot.release();
      return current.status === "idle" ? null : idle(current);
    });
  } catch (error) {
    // A refused read ran no callback; this runs before a claim queued behind the stop can write.
    readSlot.release();
    logWarning("Failed to settle the playback document on stop", error);
  }
  try {
    await ensureAudioHost();
    await sendToAudioHost("stop");
  } catch (error) {
    logWarning("Failed to stop audio", error);
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
          command: doc.command,
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
  let lease: ReadLease | undefined;
  await updatePlayback(
    epoch,
    (doc) =>
      doc.status !== "paused"
        ? doc
        : {
            status: "playing",
            rate: doc.rate,
            textDigest: doc.textDigest,
            // From the locked document, not the read above (a seek may have landed
            // in between). A read parked at its end starts over, like the element
            // itself does.
            currentTime: doc.currentTime < doc.duration ? doc.currentTime : 0,
            duration: doc.duration,
            command: doc.command + 1,
          },
    (written) => {
      if (written.status === "playing") {
        lease = new ReadLease(epoch, written.command, readSlot.claim().signal);
      }
    },
  );
  if (!lease) return false;
  try {
    return await resumeUnder(lease);
  } catch (error) {
    // Storage refused the recovery itself. Under the lease, so a stop meanwhile silences it; when
    // even that is refused, the log line is the last resort, as for a detached continuation.
    await lease.report("Resume failed", error).catch((e) => logError("Resume failed", e));
    return false;
  }
}

async function resumeUnder(lease: ReadLease): Promise<boolean> {
  const { epoch } = lease;
  let hostRefusal: string;
  try {
    if (!(await lease.hostReady())) return false;
    await lease.tellHost("resume", { epoch });
    return true;
  } catch (hostError) {
    // The host refused, usually because its context was recycled during the
    // pause and nothing is loaded there any more: replay the recorded audio
    // from the parked position.
    hostRefusal = errorText(hostError);
  }
  const record = await playbackAudio.get();
  if (record?.epoch === epoch) {
    // The play settles only when the audio ends or is interrupted.
    detach(play(lease, record.audioUri), "Replay continuation failed");
    return true;
  }
  if (await lease.settleIdle()) {
    await lease.report(
      "Resume failed",
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
    // The session's own position, never one re-derived here (the contract is on audioRoutes in
    // ./protocol), so the document never carries a phantom position.
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
