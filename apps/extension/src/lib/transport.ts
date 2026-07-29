import { browser } from "#imports";
import { ensureAudioHost, sendToAudioHost, setAudioEventSink } from "./audio-host";
import { textDigest } from "./digest";
import { surfaceError } from "./errors";
import { broadcast, type PlayerProgress, type PlayerState } from "./messages";
import {
  clearVoiceIssue,
  getSettings,
  type ParkedTransport,
  parkedTransportItem,
  recordVoiceIssue,
  voiceIssueKey,
} from "./storage";
import { getAudioUri } from "./synthesize";
import { sanitizeTextForSSML } from "./text";

// ---------------------------------------------------------------------------
// Playback transport: background-scoped state machine driving the audio
// host (Chrome: offscreen document; Firefox: in-background session; details
// in lib/audio-host.ts). The whole read is synthesized into ONE merged audio
// file (the provider chunks internally and stitches the bytes), so the
// popup's timeline spans the entire text and never jumps at chunk boundaries.
//
// Cancellation model: every (re)start bumps `generation` SYNCHRONOUSLY, as
// its first mutation: ownership is claimed before any await, so a stop or a
// newer read arriving mid-await always wins. An in-flight play belongs to one
// generation and re-checks it after EVERY await (including in error paths).
//
// MV3 lifetime: Chrome closes an idle AUDIO_PLAYBACK offscreen document ~30s
// after audio stops, and the service worker follows ~30s later; no keepalive
// can prevent that. So a parked/paused read is ALSO persisted to
// storage.session; a fresh worker restores it lazily and resume() replays the
// cached audio without re-synthesizing (the position is lost, the read isn't).
// ---------------------------------------------------------------------------

interface TransportState {
  /** Merged audio for the current read, kept for resume-after-recycle. */
  audioUri: string | null;
  /** The text the current audio belongs to (identity for the popup). */
  text: string | null;
  status: PlayerState["status"];
  rate: number;
  currentTime: number;
  duration: number;
  generation: number;
}

const state: TransportState = {
  audioUri: null,
  text: null,
  status: "idle",
  // The playback rate survives across reads: picking 1.5x once means 1.5x
  // until the user changes it, not until the next play.
  rate: 1,
  currentTime: 0,
  duration: 0,
  generation: 0,
};

// Replaying the same text with the same voice/settings must not hit the API
// again; one entry is enough: it covers "play it again" and scrub-replays.
let lastSynthesis: { key: string; audioUri: string } | null = null;

function synthesisKey(text: string, settings: Awaited<ReturnType<typeof getSettings>>): string {
  return JSON.stringify([
    text,
    settings.readAloudEncoding,
    settings.selectedVoice,
    settings.model,
    settings.style,
    settings.speed,
    settings.pitch,
    settings.volumeGainDb,
  ]);
}

export function getPlayerState(): PlayerState {
  return {
    status: state.status,
    rate: state.rate,
    textDigest: state.text !== null ? textDigest(state.text) : null,
    currentTime: state.currentTime,
    duration: state.duration,
  };
}

/** Restore a parked read persisted before the service worker was recycled.
 *  At most once per worker lifetime, only into a pristine state, and shared:
 *  concurrent callers await the SAME completion (a boolean gate would let a
 *  second caller act on pristine state mid-restore and be overwritten). */
let restorePromise: Promise<void> | null = null;
// Memoized parked value for cold-start reads. Kept in sync with clearPark/
// persistPark: a stale memo could resurrect a read the user stopped.
let parkedRead: Promise<ParkedTransport | null> | null = null;
function readParkedOnce(): Promise<ParkedTransport | null> {
  parkedRead ??= parkedTransportItem.getValue().catch(() => null);
  return parkedRead;
}

function ensureRestored(): Promise<void> {
  restorePromise ??= restoreOnce();
  return restorePromise;
}

async function restoreOnce(): Promise<void> {
  if (state.status !== "idle" || state.audioUri !== null) return;
  // Generation-guard like every other await: a start-then-stop during this
  // read leaves state LOOKING pristine; values alone can't detect it.
  const generation = state.generation;
  const parked = await readParkedOnce();
  if (
    !parked ||
    generation !== state.generation ||
    state.status !== "idle" ||
    state.audioUri !== null
  ) {
    return;
  }
  state.audioUri = parked.audioUri;
  state.text = parked.text;
  state.rate = parked.rate;
  state.currentTime = parked.currentTime;
  state.duration = parked.duration;
  state.status = "paused";
}

/** Restored view for the popup's mount refresh, with the timeline read live
 *  from the audio element when one is loaded (the mirror otherwise). */
export async function getRestoredPlayerState(): Promise<PlayerState> {
  await ensureRestored();
  if (state.status === "playing" || state.status === "paused") {
    await commitLiveProgress(state.generation);
  }
  return getPlayerState();
}

/** Best-effort: parked audio can exceed the session-storage quota, and losing
 *  the persistence fallback must never break live playback. */
async function persistPark(): Promise<void> {
  if (state.audioUri === null || state.text === null) return;
  const parked: ParkedTransport = {
    audioUri: state.audioUri,
    text: state.text,
    rate: state.rate,
    currentTime: state.currentTime,
    duration: state.duration,
  };
  // Keep the cold-start memo consistent with what's actually persisted.
  parkedRead = Promise.resolve(parked);
  try {
    await parkedTransportItem.setValue(parked);
  } catch {
    // Quota or transient storage failure; in-memory state still works.
  }
}

async function clearPark(): Promise<void> {
  // Invalidate the memo FIRST: a later cold-start-style read must not
  // resurrect a park the user just cleared by starting/stopping a read.
  parkedRead = Promise.resolve(null);
  await parkedTransportItem.setValue(null).catch(() => {});
}

/** Mirror of the element's position for playerGetState between live reads.
 *  `generation` is the generation the reading BELONGS to: the session's
 *  stamp for routed progress events, or the value captured before an await
 *  that commits a position later. Guarded like every other transport
 *  mutation: a reading that outlived its read, or landing when no read is
 *  active, must not stick. */
export function updateProgress(generation: number, progress: PlayerProgress): void {
  if (generation !== state.generation) return;
  if (state.status !== "playing" && state.status !== "paused") return;
  state.currentTime = progress.currentTime;
  state.duration = progress.duration;
}

/** Commit the element's LIVE position (the throttled mirror can trail it by
 *  up to 400ms). Best-effort: with no live element the mirror stands. */
async function commitLiveProgress(generation: number): Promise<void> {
  try {
    updateProgress(generation, await sendToAudioHost("getProgress"));
  } catch {
    // No host or nothing loaded (recycled context); keep the mirror.
  }
}

/** Status writes are generation-guarded so stale plays can't corrupt state. */
function setStatus(generation: number, status: PlayerState["status"]): boolean {
  if (generation !== state.generation) return false;
  state.status = status;
  broadcast("playerState", getPlayerState());
  return true;
}

// MV3 self-keepalive for the synthesis window: no audio is loaded yet, so
// nothing else resets the worker's ~30s idle timer (the offscreen document's
// AUDIO_PLAYBACK lifetime can't be extended without audio either). Calling
// any extension API resets the timer; bounded so a hung provider can't pin
// the worker forever.
let synthesisKeepalive: ReturnType<typeof setInterval> | undefined;
function startSynthesisKeepalive(): void {
  stopSynthesisKeepalive();
  const deadline = Date.now() + 240_000;
  synthesisKeepalive = setInterval(() => {
    if (Date.now() > deadline) {
      stopSynthesisKeepalive();
      return;
    }
    void browser.runtime.getPlatformInfo();
  }, 20_000);
}
function stopSynthesisKeepalive(): void {
  if (synthesisKeepalive !== undefined) {
    clearInterval(synthesisKeepalive);
    synthesisKeepalive = undefined;
  }
}

/** Start reading `text` from the beginning (cancels any current read). */
export async function startReading(text: string, speed?: number): Promise<boolean> {
  if (!text.trim()) return false;

  // Claim ownership SYNCHRONOUSLY, before ANY await (even a resolved one),
  // so a concurrent stop or a second read can never interleave with this one.
  const generation = ++state.generation;
  state.audioUri = null;
  state.text = text;
  if (speed !== undefined) state.rate = speed;
  state.currentTime = 0;
  state.duration = 0;
  setStatus(generation, "synthesizing");
  broadcast("playerProgress", { currentTime: 0, duration: 0 });
  startSynthesisKeepalive();

  // Rate memory: a parked session (possibly from a recycled worker) carries
  // the user's chosen rate; apply it unless the caller passed one.
  if (speed === undefined && state.rate === 1) {
    const parked = await readParkedOnce();
    if (parked && generation === state.generation && state.rate === 1) {
      state.rate = parked.rate;
    }
  }
  void clearPark();

  // Silence any current audio. Deliberately NOT stopReading(): that would
  // bump the generation again and steal our claim.
  try {
    await ensureAudioHost();
    await sendToAudioHost("stop");
  } catch (error) {
    console.warn("Failed to prepare offscreen document", error);
  }
  if (generation !== state.generation) return false;

  // Runs detached so readAloud returns immediately; failures are surfaced to
  // the user via surfaceError inside, never lost.
  void synthesizeAndPlay(generation, text);
  return true;
}

async function synthesizeAndPlay(generation: number, text: string): Promise<void> {
  // ONE settings snapshot for everything: cache key, synthesis parameters,
  // and the issue key used on failure, so they can never diverge.
  const settings = await getSettings().catch(() => null);
  if (generation !== state.generation) return;
  if (!settings) {
    stopSynthesisKeepalive();
    await surfaceError(new Error("Could not read settings"));
    resetIfCurrent(generation);
    return;
  }
  const issueKey = settings.selectedVoice
    ? voiceIssueKey(
        settings.selectedVoice.providerId,
        settings.selectedVoice.voiceId,
        settings.model,
      )
    : null;

  let audioUri: string;
  try {
    // Sanitize HERE, not in the callers: `state.text` must stay the caller's
    // raw text so the popup's identity digest matches what the user typed.
    const cleanText = sanitizeTextForSSML(text);
    const key = synthesisKey(cleanText, settings);
    let synthesizedNow = false;
    if (lastSynthesis?.key === key) {
      audioUri = lastSynthesis.audioUri;
    } else {
      audioUri = await getAudioUri({
        text: cleanText,
        encoding: settings.readAloudEncoding,
        settings,
      });
      lastSynthesis = { key, audioUri };
      synthesizedNow = true;
    }
    // Only a REAL API success proves the voice works; a cache hit says
    // nothing about current credentials/entitlements. Gated on generation:
    // a superseded read must not touch issue state either.
    if (synthesizedNow && issueKey && generation === state.generation) {
      await clearVoiceIssue(issueKey).catch(() => {});
    }
  } catch (error) {
    console.error("Synthesis failed", error);
    // Stale reads must NOT stop the keepalive: the singleton interval
    // belongs to the NEWEST generation (startReading re-arms it on claim).
    if (generation !== state.generation) return;
    stopSynthesisKeepalive();
    if (issueKey) await recordVoiceIssue(issueKey, String(error)).catch(() => {});
    // The awaits above can outlast this read; never surface a stale error.
    if (generation !== state.generation) return;
    await surfaceError(error);
    resetIfCurrent(generation);
    return;
  }

  if (generation !== state.generation) return;
  stopSynthesisKeepalive();
  state.audioUri = audioUri;
  await playCurrent(generation);
}

/** Play the merged audio; resolves when playback ends. */
async function playCurrent(generation: number): Promise<void> {
  const audioUri = state.audioUri;
  if (!audioUri) return;
  try {
    await ensureAudioHost();
    if (generation !== state.generation) return;
    setStatus(generation, "playing");
    await sendToAudioHost("play", { audioUri, rate: state.rate, generation });
  } catch (error) {
    if (generation !== state.generation) return;
    if (state.status === "paused") {
      // Chrome closed the idle offscreen document mid-pause, severing the
      // pending play. The audio is cached; stay parked so resume() replays
      // it. This is lifecycle housekeeping, not an error the user caused.
      await persistPark();
      return;
    }
    console.error("Playback failed", error);
    await surfaceError(error);
    resetIfCurrent(generation);
    return;
  }
  // Natural end: PARK instead of reset; the audio stays loaded so the user
  // can scrub back on the timeline and replay without re-synthesizing.
  // notifyEnded may have parked already (its message can beat this resolve);
  // park exactly once so the popup gets one broadcast.
  await commitLiveProgress(generation);
  if (generation === state.generation && state.status === "playing") {
    setStatus(generation, "paused");
    await persistPark();
  }
}

/** The session notifies us (with its generation stamp) whenever the main
 *  audio reaches its natural end. */
export function notifyEnded(generation: number): boolean {
  if (generation !== state.generation || state.status !== "playing") return false;
  const parked = setStatus(generation, "paused");
  // Refine the parked position from the live element; detached so this stays
  // synchronous for the message router, re-guarded inside because a read
  // started during the commit must never be snapshotted as parked.
  if (parked) {
    void commitLiveProgress(generation).then(() => {
      if (generation !== state.generation || state.status !== "paused") return;
      broadcast("playerProgress", { currentTime: state.currentTime, duration: state.duration });
      return persistPark();
    });
  }
  return parked;
}

function resetIfCurrent(generation: number): void {
  if (generation !== state.generation) return;
  state.status = "idle";
  state.audioUri = null;
  state.text = null;
  state.currentTime = 0;
  state.duration = 0;
  broadcast("playerState", getPlayerState());
}

export async function stopReading(): Promise<boolean> {
  const generation = ++state.generation;
  stopSynthesisKeepalive();
  state.audioUri = null;
  state.text = null;
  state.currentTime = 0;
  state.duration = 0;
  // Claimed synchronously like the generation: a progress message routed
  // while the stop below is in flight must find the transport already idle.
  state.status = "idle";
  void clearPark();
  try {
    await ensureAudioHost();
    await sendToAudioHost("stop");
  } catch (error) {
    console.warn("Failed to stop audio", error);
  }
  setStatus(generation, "idle");
  // Gated like setStatus: a stop superseded by a newer read must not zero
  // the popup timeline that read is already painting.
  if (generation === state.generation) {
    broadcast("playerProgress", { currentTime: 0, duration: 0 });
  }
  return true;
}

export async function pause(): Promise<boolean> {
  if (state.status !== "playing") return false;
  const generation = state.generation;
  try {
    await sendToAudioHost("pause");
    // Commit where the element actually stopped, not the throttled mirror.
    await commitLiveProgress(generation);
  } catch (error) {
    // Document already gone; the audio is not playing anymore, which is
    // what the user asked for. Park so resume() can replay the cached read.
    console.warn("Pause reached no offscreen document", error);
  }
  const parked = setStatus(generation, "paused");
  if (parked) await persistPark();
  return parked;
}

export async function resume(): Promise<boolean> {
  await ensureRestored();
  if (state.status !== "paused") return false;
  // Claim a fresh generation up front, like startReading: it orphans the
  // original play-continuation (which must not park this read AGAIN when the
  // resumed audio ends; notifyEnded owns that) and stamps the session's
  // events for everything that follows.
  const generation = ++state.generation;
  try {
    await ensureAudioHost();
    await sendToAudioHost("resume", { generation });
    return setStatus(generation, "playing");
  } catch {
    // Chrome recycled the offscreen document during a long pause: replay the
    // cached merged audio (position is lost, the read is not; no re-synthesis).
    if (generation !== state.generation || !state.audioUri) return false;
    // Replaying from scratch: reset the mirror so the popup never shows the
    // parked offset over audio that restarted at 0 (mirrors startReading).
    state.currentTime = 0;
    broadcast("playerProgress", { currentTime: 0, duration: state.duration });
    void playCurrent(generation);
    return true;
  }
}

export async function setRate(rate: number): Promise<boolean> {
  await ensureRestored();
  state.rate = rate;
  broadcast("playerState", getPlayerState());
  if (state.status === "paused") void persistPark();
  try {
    await sendToAudioHost("setRate", { rate });
    return true;
  } catch {
    // No document; the rate is stored and applied on the next play/resume.
    return state.status !== "playing";
  }
}

export async function seekBy(seconds: number): Promise<boolean> {
  const generation = state.generation;
  try {
    // The session rejects when nothing seekable is loaded and resolves with
    // the position the ELEMENT committed, so state never carries a phantom
    // position or a re-clamp against a stale mirror duration.
    updateProgress(generation, await sendToAudioHost("seekBy", { seconds }));
    return true;
  } catch {
    return false;
  }
}

export async function seekTo(seconds: number): Promise<boolean> {
  const generation = state.generation;
  try {
    updateProgress(generation, await sendToAudioHost("seekTo", { seconds }));
    return true;
  } catch {
    return false;
  }
}

// On Firefox the audio session lives in this same context and raises its
// stamped events through this sink (on Chrome the offscreen document sends
// the same events as runtime messages, routed by the background's handlers).
// A callback registration, not an import from audio-host, to avoid a cycle.
setAudioEventSink({
  onEnded: (event) => {
    notifyEnded(event.generation);
  },
  onProgress: (progress) => {
    updateProgress(progress.generation, progress);
  },
});
