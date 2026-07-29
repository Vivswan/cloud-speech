import { browser } from "#imports";
import type { ProviderValidationResult } from "@/lib/provider-validation";
import type { ProviderId } from "@/providers/types";

// ---------------------------------------------------------------------------
// Typed message protocol. Background owns all provider calls; offscreen owns
// audio; popup/content only send/receive these messages.
// ---------------------------------------------------------------------------

/** Messages handled by the background service worker. */
export interface BackgroundMessages {
  fetchVoices: { payload: undefined; result: number };
  validateProvider: {
    payload: { providerId: ProviderId; credentials?: Record<string, string> };
    result: ProviderValidationResult;
  };
  readAloud: { payload: { text: string; speed?: number }; result: boolean };
  stopReading: { payload: undefined; result: boolean };
  download: { payload: { text: string }; result: boolean };
  previewVoice: {
    payload: { providerId: ProviderId; voiceId: string; model: string; language?: string };
    result: boolean;
  };
  stopPreview: { payload: undefined; result: boolean };
  playerPause: { payload: undefined; result: boolean };
  playerResume: { payload: undefined; result: boolean };
  playerSeekBy: { payload: { seconds: number }; result: boolean };
  playerSeekTo: { payload: { seconds: number }; result: boolean };
  playerSetRate: { payload: { rate: number }; result: boolean };
  playerGetState: { payload: undefined; result: PlayerState };
  playbackEnded: { payload: { generation: number }; result: boolean };
  scanVoices: {
    payload: { providerId: string };
    result: { familiesChecked: number; familiesUnavailable: number };
  };
}

export type BackgroundMessageId = keyof BackgroundMessages;

/** Messages handled by the offscreen audio document. `play`/`resume` carry
 *  the transport generation so the session can stamp the events it raises;
 *  seeks resolve with the position the element actually committed, so the
 *  transport records reality instead of re-deriving it from its own
 *  (possibly stale) mirror. */
export interface OffscreenMessages {
  play: { payload: { audioUri: string; rate: number; generation: number }; result: string };
  stop: { payload: undefined; result: string };
  pause: { payload: undefined; result: string };
  resume: { payload: { generation: number }; result: string };
  seekBy: { payload: { seconds: number }; result: PlayerProgress };
  seekTo: { payload: { seconds: number }; result: PlayerProgress };
  setRate: { payload: { rate: number }; result: string };
  getProgress: { payload: undefined; result: PlayerProgress };
  previewPlay: { payload: { audioUri: string }; result: string };
  previewStop: { payload: undefined; result: string };
}

export type OffscreenMessageId = keyof OffscreenMessages;

/** Player status broadcast from background to any listening UI. */
export interface PlayerState {
  status: "idle" | "synthesizing" | "playing" | "paused";
  rate: number;
  /** Digest of the text the loaded/last audio belongs to (null when idle);
   *  the popup uses it to tell "resume this" from "that was different text". */
  textDigest: string | null;
  /** Last known playback position; restores the timeline on popup reopen. */
  currentTime: number;
  duration: number;
  /** Voice row currently auditioning (`providerId:voiceId:model`), owned by
   *  the background's preview channel. Only playerGetState responses carry
   *  it; transport broadcasts omit it so they never clobber a live preview. */
  previewingKey?: string | null;
}

/** Progress broadcast from the offscreen document (throttled timeupdate). */
export interface PlayerProgress {
  currentTime: number;
  duration: number;
}

/** Progress event as the audio session raises it: stamped with the transport
 *  generation of the play it belongs to, so the background can reject a
 *  broadcast that outlived its read. */
export interface StampedPlayerProgress extends PlayerProgress {
  generation: number;
}

/** Background-owned broadcast for a settled preview (natural end, failure,
 *  stop). Keyed so a popup already showing a NEWER preview never clears the
 *  wrong row. */
export interface PreviewEndedPayload {
  key: string;
}

/** Error surfaced to the active tab's content-script toast. */
export interface ErrorPayload {
  title: string;
  message: string;
}

export interface RuntimeMessage {
  id: string;
  payload?: unknown;
  /** Present + true → only the offscreen document handles it. */
  offscreen?: boolean;
}

/** Structured offscreen reply: failures must reach the caller, never become
 *  a silent `undefined` response. */
export type OffscreenResponse =
  | { ok: true; value: OffscreenMessages[OffscreenMessageId]["result"] }
  | { ok: false; error: string };

/** Popup requests must never hang a UI state forever: a stalled provider or a
 *  dropped response settles as a rejection after this window. Generous on
 *  purpose: long-text downloads legitimately take a while. */
const BACKGROUND_TIMEOUT_MS = 120_000;

export function sendToBackground<K extends BackgroundMessageId>(
  id: K,
  ...args: BackgroundMessages[K]["payload"] extends undefined
    ? []
    : [BackgroundMessages[K]["payload"]]
): Promise<BackgroundMessages[K]["result"]> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${id} timed out after ${BACKGROUND_TIMEOUT_MS / 1000}s`)),
      BACKGROUND_TIMEOUT_MS,
    );
    browser.runtime.sendMessage({ id, payload: args[0] }).then(
      (value) => {
        clearTimeout(timer);
        resolve(value as BackgroundMessages[K]["result"]);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Fire-and-forget broadcast (popup may be closed; ignore delivery errors). */
export function broadcast(id: string, payload: unknown): void {
  browser.runtime.sendMessage({ id, payload }).catch(() => {});
}
