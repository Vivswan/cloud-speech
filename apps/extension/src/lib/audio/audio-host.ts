import { browser } from "#imports";
import { logWarning } from "../errors/log";
import {
  audioRoutes,
  call,
  invoke,
  type PayloadArgs,
  type Result,
  type RouteId,
} from "../messaging/protocol";
import {
  type AudioSessionHandlers,
  type AudioSessionListeners,
  createAudioSession,
} from "./audio-session";
import { type AudioEvent, applyAudioEvent } from "./playback";

// The one per-browser seam between the transport and the audio session
// (lib/audio/audio-session.ts). import.meta.env.FIREFOX is a build-time constant,
// so the branch not taken is dead code in the output.
//   Chrome   -> the session lives in an offscreen document, reached over runtime messages
//   Firefox  -> no offscreen API, but the background is an event page with a real DOM; the session runs here and calls are direct

// --- Firefox: in-background session -----------------------------------------

let session: AudioSessionHandlers | null = null;

/** The session's position events on either browser: the offscreen document's audioProgress and
 *  audioEnded messages on Chrome, the in-background listeners below on Firefox. A write the
 *  document refuses is a warning, never a notice: these fire every second while audio sounds. */
export async function recordAudioEvent(event: AudioEvent): Promise<void> {
  try {
    await applyAudioEvent(event);
  } catch (error) {
    logWarning("Audio position event not recorded", error);
  }
}

const firefoxListeners: AudioSessionListeners = {
  keepalive: () => {
    // Any extension API call resets the event page's idle timer, which keeps
    // Firefox from suspending the page while audio is loaded.
    void browser.runtime.getPlatformInfo();
  },
  audioProgress: (position) => {
    void recordAudioEvent({ kind: "progress", ...position });
  },
  audioEnded: (position) => {
    void recordAudioEvent({ kind: "ended", ...position });
  },
};

function getSession(): AudioSessionHandlers {
  session ??= createAudioSession(firefoxListeners);
  return session;
}

// --- Chrome: offscreen document ----------------------------------------------

// getContexts can report the offscreen document before its scripts have run,
// and a message sent then is silently lost; memoize check+create as one unit
// so every caller awaits the same in-flight promise.
let creating: Promise<void> | null = null;

function ensureOffscreenDocument(): Promise<void> {
  creating ??= (async () => {
    const url = browser.runtime.getURL("/offscreen.html");
    const contexts = await browser.runtime.getContexts({
      contextTypes: ["OFFSCREEN_DOCUMENT" as never],
      documentUrls: [url],
    });
    if (contexts.length === 0) {
      await browser.offscreen.createDocument({
        url,
        reasons: ["AUDIO_PLAYBACK" as never],
        justification: "Play synthesized speech (MV3 service workers cannot play audio)",
      });
    }
  })().finally(() => {
    creating = null;
  });
  return creating;
}

// --- Public seam --------------------------------------------------------------

export async function ensureAudioHost(): Promise<void> {
  if (import.meta.env.FIREFOX) {
    getSession();
    return;
  }
  await ensureOffscreenDocument();
}

export function sendToAudioHost<K extends RouteId<"audio">>(
  id: K,
  ...args: PayloadArgs<"audio", K>
): Promise<Result<"audio", K>> {
  if (import.meta.env.FIREFOX) {
    return invoke(audioRoutes, getSession(), id, ...args);
  }
  return call("audio", id, ...args);
}
