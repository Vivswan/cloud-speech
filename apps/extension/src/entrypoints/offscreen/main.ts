import { browser } from "#imports";
import { createAudioSession } from "@/lib/audio-session";
import { broadcast, type OffscreenResponse, type RuntimeMessage } from "@/lib/messages";

// Chrome-only offscreen audio document — MV3 service workers cannot play
// audio. The player itself lives in @/lib/audio-session (shared with the
// Firefox in-background host); this file only hosts it and bridges its
// events and commands over runtime messages.

const handlers = createAudioSession((id, payload) => {
  // keepalive/playbackEnded land on the background's message handlers;
  // playerProgress/previewEnded double as popup broadcasts. All four are the
  // same fire-and-forget runtime message.
  broadcast(id, payload);
});

browser.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (!message?.offscreen) return;
  const handler = handlers[message.id];
  if (!handler) return;

  handler(message.payload).then(
    (value) => sendResponse({ ok: true, value } satisfies OffscreenResponse),
    (error) => {
      console.error(`Offscreen handler ${message.id} failed`, error);
      sendResponse({ ok: false, error: String(error) } satisfies OffscreenResponse);
    },
  );
  return true;
});
