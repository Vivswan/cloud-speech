import { browser } from "#imports";
import { ensureAudioHost, sendToAudioHost } from "./audio-host";
import { credentialsDigest, textDigest } from "./digest";
import { surfaceError } from "./errors";
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

// ---------------------------------------------------------------------------
// Playback transport: drives the audio host (Chrome: offscreen document;
// Firefox: in-background session; details in lib/audio-host.ts) from the
// playback document in storage.session (lib/playback.ts). The document is the
// only state: the popup watches it, a recycled service worker reads it, and
// every transition here is a claim (a new read, a stop) or a compare-and-swap
// on the epoch the work started under. A swap that comes back null means the
// read was superseded, and the superseded work simply does nothing.
//
// The whole read is synthesized into ONE merged audio file (the provider
// chunks internally and stitches the bytes), so the timeline spans the entire
// text. The audio lives in IndexedDB (playbackAudio) keyed by the read's
// epoch: a replay of the same text with the same settings hits it instead of
// the API, and a resume after Chrome closed the idle offscreen document (~30s
// without sound) replays it from the parked position.
// ---------------------------------------------------------------------------

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

// The synthesis in flight for the current read; a newer read or a stop
// cancels its provider requests instead of letting them finish unpaid-for.
const readSlot = new Slot();

// Host commands whose continuation outlives the state they were issued under:
// a `play` settles only when the audio ends or is interrupted, and a resume's
// recovery (the record lookup) can outlast a pause and a second resume. The
// read's epoch cannot tell those apart (it is the read's identity, not the
// command's), so each play/resume takes a command number INSIDE its locked
// document update, and a continuation acts only while it is still the newest,
// checked inside its own locked update. In-memory on purpose: a recycled
// context has no pending commands.
let mainCommand = 0;

// MV3 self-keepalive for the synthesis window: no audio is loaded yet, so
// nothing else resets the worker's ~30s idle timer (the offscreen document's
// AUDIO_PLAYBACK lifetime can't be extended without audio either). Calling
// any extension API resets the timer; bounded so a hung provider can't pin
// the worker forever. Owned by the read's signal: when the slot aborts the
// read, its keepalive goes with it.
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

/** Run once when the background context starts. A fresh context has no
 *  synthesis in flight, so a document still marked synthesizing belongs to a
 *  context that died mid-read and settles idle. At epoch 0 the browser
 *  session is new (the document is session-scoped, the audio record is not),
 *  so any record left in IndexedDB is a previous session's. */
export async function recoverPlayback(): Promise<void> {
  const current = await readPlayback();
  if (current.epoch === 0) await playbackAudio.clear();
  if (current.status === "synthesizing") {
    await updatePlayback(current.epoch, (doc) => (doc.status === "synthesizing" ? idle(doc) : doc));
  }
}

/** Start reading `text` from the beginning (cancels any current read). */
export async function startReading(text: string, speed?: number): Promise<boolean> {
  if (!text.trim()) return false;

  // Claim the slot SYNCHRONOUSLY, before any await: the previous read's
  // synthesis is cancelled in call order, the same order the playback lock
  // hands out epochs below, so slot owner and document owner never diverge.
  const signal = readSlot.claim();
  // The rate outlives the read: picking 1.5x once means 1.5x until the user
  // changes it, not until the next play.
  const claimed = await claimPlayback((current) => ({
    status: "synthesizing",
    rate: speed ?? current.rate,
    textDigest: textDigest(text),
  }));
  startSynthesisKeepalive(signal);

  // Silence any current audio. Deliberately NOT stopReading(): that would
  // claim another epoch and orphan this read.
  try {
    await ensureAudioHost();
    await sendToAudioHost("stop");
  } catch (error) {
    console.warn("Failed to prepare the audio host", error);
  }

  // Runs detached so readAloud returns immediately; failures are surfaced to
  // the user inside, never lost.
  void synthesizeAndPlay(claimed.epoch, text, signal);
  return true;
}

async function synthesizeAndPlay(epoch: number, text: string, signal: AbortSignal): Promise<void> {
  // ONE settings snapshot for everything: cache key, synthesis parameters,
  // and the issue key used on failure, so they can never diverge.
  let settings: Settings;
  try {
    settings = await getSettings();
  } catch (error) {
    await failRead(epoch, signal, error, null);
    return;
  }
  // The selection doubles as the issue reference: one voice on one engine.
  const issueRef = settings.selection;

  // Sanitize HERE, not in the callers: the document's digest is over the
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
      // A REAL synthesis success is information about the voice even when
      // this read was superseded meanwhile; a cache hit says nothing about
      // current credentials, so it never clears.
      if (issueRef) await clearVoiceIssue(issueRef).catch(() => {});
    }
  } catch (error) {
    await failRead(epoch, signal, error, issueRef);
    return;
  }

  // Superseded or stopped while synthesizing: the newer owner has the slot;
  // nothing of this read may sound or be recorded.
  if (signal.aborted) return;
  stopSynthesisKeepalive();
  await playbackAudio.set({ epoch, synthesisKey: key, audioUri });
  await play(epoch, audioUri);
}

/** A read that failed on its own account: mark the voice, settle idle, tell
 *  the user. A read whose signal aborted was superseded or stopped: its
 *  failure (its own cancellation included) is nobody's news. */
async function failRead(
  epoch: number,
  signal: AbortSignal,
  error: unknown,
  issueRef: VoiceModelRef | null,
): Promise<void> {
  if (signal.aborted) return;
  stopSynthesisKeepalive();
  console.error("Synthesis failed", error);
  if (issueRef) await recordVoiceIssue(issueRef, String(error)).catch(() => {});
  const settled = await updatePlayback(epoch, (current) =>
    current.status === "synthesizing" ? idle(current) : current,
  );
  // The issue reference names the provider the request went to; a fetch that
  // never got an answer cannot name it itself.
  if (settled?.status === "idle") {
    await surfaceError(error, issueRef ? { providerId: issueRef.providerId } : {});
  }
}

/** Bring the audio host up, then re-read the document: creating an offscreen
 *  document takes long enough for a pause or a rate change to land meanwhile,
 *  and a pause sent while no host existed reached nothing. Null when the read
 *  no longer plays under `epoch`; the host command must then not go out. */
async function hostReadyFor(
  epoch: number,
): Promise<Extract<Playback, { status: "playing" }> | null> {
  await ensureAudioHost();
  const current = await readPlayback();
  return current.status === "playing" && current.epoch === epoch ? current : null;
}

/** Sound the read's audio from the document's position: a read just
 *  synthesized (from 0), or one a resume found nothing loaded for (the
 *  document already says playing at the parked position then; `replayFor` is
 *  that resume's command, and the replay is dropped when a newer command took
 *  the channel by the time this locked update runs). The session reports the
 *  natural end through audioEnded; this only settles the failures of the play
 *  itself. Resolves when the audio ends or is interrupted, so callers
 *  answering a request run it detached. */
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
    // pending play too: the read is parked, its audio recorded, and resume
    // replays it. A rejection landing after a later play or resume took the
    // channel is that severed promise, whatever the document says now.
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
  // The document turns before the host is told, like every other transition
  // here: a resume racing this pause re-reads the document right before it
  // sends its own command, so the later transition decides what sounds.
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
  // pause, and the document keeps the last position it was told. Otherwise
  // the element's exact position replaces the last throttled tick.
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
  try {
    if (!(await hostReadyFor(epoch))) return false;
    await sendToAudioHost("resume", { epoch });
    return true;
  } catch {
    // The session's context was recycled during the pause (nothing is loaded
    // there any more): replay the recorded audio from the parked position.
  }
  const record = await playbackAudio.get();
  // A pause and a second resume may have taken the channel meanwhile; the
  // outcome of this recovery is then theirs to decide.
  if (command !== mainCommand) return false;
  if (record?.epoch === epoch) {
    // Detached: the play settles only when the audio ends, and the caller is
    // answering a request. Failures are surfaced inside.
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
    // The session rejects when nothing is loaded and resolves with the
    // position the ELEMENT committed (or will start at, duration 0, while it
    // is still loading), so the document never carries a phantom position.
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
