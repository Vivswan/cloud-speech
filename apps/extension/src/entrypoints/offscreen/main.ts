import { browser } from "#imports";
import { createAudioSession } from "@/lib/audio-session";
import {
  broadcast,
  type OffscreenMessageId,
  type OffscreenMessages,
  type OffscreenResponse,
  type RuntimeMessage,
} from "@/lib/messages";

// Chrome-only offscreen audio document; MV3 service workers cannot play
// audio. The player itself lives in @/lib/audio-session (shared with the
// Firefox in-background host); this file only hosts it and bridges its
// events and commands over runtime messages.

const handlers = createAudioSession((id, payload) => {
  // keepalive/playbackEnded land on the background's message handlers;
  // playerProgress doubles as a popup broadcast. All three are the same
  // fire-and-forget runtime message. (Preview lifecycle events are
  // background-owned; the session raises none.)
  broadcast(id, payload);
});

browser.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
  if (!message?.offscreen) return;
  if (!Object.hasOwn(handlers, message.id)) return;
  // The wire delivers untyped payloads; sendToAudioHost is the typed end of
  // this channel, so the dispatch re-widens to match the wire.
  const handler = handlers[message.id as OffscreenMessageId] as (
    payload: unknown,
  ) => Promise<OffscreenMessages[OffscreenMessageId]["result"]>;

  handler(message.payload).then(
    (value) => sendResponse({ ok: true, value } satisfies OffscreenResponse),
    (error) => {
      console.error(`Offscreen handler ${message.id} failed`, error);
      sendResponse({ ok: false, error: String(error) } satisfies OffscreenResponse);
    },
  );
  return true;
});
