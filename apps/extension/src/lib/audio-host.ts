import { browser } from "#imports";
import {
  type AudioSessionHandlers,
  type AudioSessionListeners,
  createAudioSession,
} from "./audio-session";
import { applyAudioEvent } from "./playback";
import { audioRoutes, call, invoke, type PayloadArgs, type Result, type RouteId } from "./protocol";

// ---------------------------------------------------------------------------
// The audio host is the ONE per-browser seam between the transport and the
// audio session (lib/audio-session.ts):
//  - Chrome: the session lives in an offscreen document; ensureAudioHost
//    creates it and sendToAudioHost talks to it over runtime messages.
//  - Firefox: no offscreen API exists, but the background is an event page
//    with a real DOM; the session runs right here and calls are direct.
//
// import.meta.env.FIREFOX is a build-time constant, so the branch not taken
// is dead code in the output.
// ---------------------------------------------------------------------------

// --- Firefox: in-background session -----------------------------------------

let session: AudioSessionHandlers | null = null;

// The session's position events go straight into the playback document, the
// same way the background's audioProgress/audioEnded routes apply them on
// Chrome.
const firefoxListeners: AudioSessionListeners = {
  keepalive: () => {
    // Any extension API call resets the event page's idle timer; this is
    // what keeps Firefox from suspending the page while audio is loaded.
    void browser.runtime.getPlatformInfo();
  },
  audioProgress: (position) => {
    void applyAudioEvent({ kind: "progress", ...position });
  },
  audioEnded: (position) => {
    void applyAudioEvent({ kind: "ended", ...position });
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

/** Ensure the audio host is ready to receive commands. */
export async function ensureAudioHost(): Promise<void> {
  if (import.meta.env.FIREFOX) {
    getSession();
    return;
  }
  await ensureOffscreenDocument();
}

/** Send a command to the audio session, wherever it lives. */
export function sendToAudioHost<K extends RouteId<"audio">>(
  id: K,
  ...args: PayloadArgs<"audio", K>
): Promise<Result<"audio", K>> {
  if (import.meta.env.FIREFOX) {
    return invoke(audioRoutes, getSession(), id, ...args);
  }
  return call("audio", id, ...args);
}
