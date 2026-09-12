import { browser } from "#imports";
import {
  type AudioSessionHandlers,
  type AudioSessionListeners,
  createAudioSession,
} from "./audio-session";
import { applyAudioEvent } from "./playback";
import { audioRoutes, call, invoke, type PayloadArgs, type Result, type RouteId } from "./protocol";

// The one per-browser seam between the transport and the audio session
// (lib/audio-session.ts). import.meta.env.FIREFOX is a build-time constant,
// so the branch not taken is dead code in the output.
//   Chrome   -> the session lives in an offscreen document, reached over runtime messages
//   Firefox  -> no offscreen API, but the background is an event page with a real DOM; the session runs here and calls are direct

// --- Firefox: in-background session -----------------------------------------

let session: AudioSessionHandlers | null = null;

// Position events go straight into the playback document, as the
// background's audioProgress/audioEnded routes do on Chrome.
const firefoxListeners: AudioSessionListeners = {
  keepalive: () => {
    // Any extension API call resets the event page's idle timer, which keeps
    // Firefox from suspending the page while audio is loaded.
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
