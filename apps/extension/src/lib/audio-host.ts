import { browser } from "#imports";
import { type AudioSessionHandlers, createAudioSession } from "./audio-session";
import {
  broadcast,
  type OffscreenMessageId,
  type OffscreenMessages,
  type OffscreenResponse,
} from "./messages";

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

/** Session events the transport needs to observe. Registered by transport.ts
 *  at module scope (a callback, not an import, to avoid a module cycle).
 *  Chrome routes the same events through runtime messages instead. */
export interface AudioEventSink {
  onEnded: () => void;
  onProgress: (progress: { currentTime: number; duration: number }) => void;
}

let sink: AudioEventSink | null = null;

export function setAudioEventSink(next: AudioEventSink): void {
  sink = next;
}

// --- Firefox: in-background session -----------------------------------------

let session: AudioSessionHandlers | null = null;

function getSession(): AudioSessionHandlers {
  session ??= createAudioSession((id, payload) => {
    switch (id) {
      case "keepalive":
        // Any extension API call resets the event page's idle timer; this is
        // what keeps Firefox from suspending the page while audio is loaded.
        void browser.runtime.getPlatformInfo();
        break;
      case "playbackEnded":
        sink?.onEnded();
        break;
      case "playerProgress":
        sink?.onProgress(payload as { currentTime: number; duration: number });
        broadcast("playerProgress", payload);
        break;
      case "previewEnded":
        broadcast("previewEnded", {});
        break;
    }
  });
  return session;
}

// --- Chrome: offscreen document ----------------------------------------------

let creating: Promise<void> | null = null;

async function ensureOffscreenDocument(): Promise<void> {
  // A creation may be in flight: getContexts can already report the document
  // while its scripts haven't run yet, and a message sent then is silently lost.
  // Always wait for the creating call instead of trusting the early return.
  if (creating) {
    await creating;
    return;
  }

  const url = browser.runtime.getURL("/offscreen.html");

  const contexts = await browser.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as never],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;

  if (!creating) {
    creating = browser.offscreen
      .createDocument({
        url,
        reasons: ["AUDIO_PLAYBACK" as never],
        justification: "Play synthesized speech (MV3 service workers cannot play audio)",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
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
export async function sendToAudioHost<K extends OffscreenMessageId>(
  id: K,
  ...args: OffscreenMessages[K]["payload"] extends undefined
    ? []
    : [OffscreenMessages[K]["payload"]]
): Promise<OffscreenMessages[K]["result"]> {
  if (import.meta.env.FIREFOX) {
    const handler = getSession()[id];
    if (!handler) throw new Error(`No audio handler for ${id}`);
    return handler(args[0]);
  }

  const response = (await browser.runtime.sendMessage({
    id,
    payload: args[0],
    offscreen: true,
  })) as OffscreenResponse | undefined;

  if (!response) throw new Error(`Offscreen did not respond to ${id}`);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}
