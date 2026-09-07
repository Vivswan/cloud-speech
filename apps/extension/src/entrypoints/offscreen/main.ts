import { browser } from "#imports";
import { type AudioSessionListeners, createAudioSession } from "@/lib/audio-session";
import { audioRoutes, createDispatcher, emit } from "@/lib/protocol";

// Chrome-only offscreen audio document; MV3 service workers cannot play
// audio. The player itself lives in @/lib/audio-session (shared with the
// Firefox in-background host); this file only hosts it and bridges its
// events and commands over runtime messages.

const listeners: AudioSessionListeners = {
  keepalive: (payload) => emit("background", "keepalive", payload),
  audioProgress: (payload) => emit("background", "audioProgress", payload),
  audioEnded: (payload) => emit("background", "audioEnded", payload),
};

browser.runtime.onMessage.addListener(
  createDispatcher("audio", audioRoutes, createAudioSession(listeners)),
);
