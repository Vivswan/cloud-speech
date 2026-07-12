import { browser } from "#imports";
import { broadcast, type OffscreenResponse, type RuntimeMessage } from "@/lib/messages";

// Offscreen audio document — MV3 service workers cannot play audio.
// Two independent channels: `main` for reads, `preview` for voice auditions
// (a preview must never interrupt an active read).
//
// Every handler returns a STRUCTURED response ({ok, value|error}) so failures
// reach the caller instead of silently becoming `undefined`. A pending `play`
// is explicitly settled ("interrupted") by stop or a newer play — its promise
// must never dangle when its media callbacks get overwritten.

const main = new Audio();
const preview = new Audio();

let settleCurrentPlay: ((outcome: "interrupted") => void) | null = null;
let settleCurrentPreview: ((outcome: "interrupted") => void) | null = null;
// A pause can arrive BEFORE the audio's metadata loads (main.paused is still
// true then, so pause() alone can't stop the deferred autoplay). Remember the
// intent and honor it when loadedmetadata fires.
let mainPauseRequested = false;

// Keepalive: while the main channel has audio loaded, ping the service
// worker so the transport's in-memory state survives (MV3 workers idle out
// after ~30s). The synthesis window has its own keepalive in the background —
// this document itself only lives ~30s without audio (AUDIO_PLAYBACK rule).
let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

function updateKeepalive(): void {
  // Active while audio is LOADED — even paused or finished. A parked read
  // (ended, still scrubbable) needs the service worker's transport state
  // alive exactly as much as a long pause does. `stop` clears the src.
  const active = main.src !== "";
  if (active && keepaliveTimer === undefined) {
    keepaliveTimer = setInterval(() => {
      browser.runtime.sendMessage({ id: "keepalive" }).catch(() => {});
    }, 20_000);
  } else if (!active && keepaliveTimer !== undefined) {
    clearInterval(keepaliveTimer);
    keepaliveTimer = undefined;
  }
}

main.onplay = updateKeepalive;
main.onpause = updateKeepalive;
main.onended = updateKeepalive;

// Persistent (never reassigned): the transport parks on end, and replays
// started via `resume` end OUTSIDE any pending play-promise — this is the
// only signal that reaches the background for those.
main.addEventListener("ended", () => {
  browser.runtime.sendMessage({ id: "playbackEnded" }).catch(() => {});
});

// Throttled progress broadcast for the mini-player timeline.
let lastProgressAt = 0;
main.ontimeupdate = () => {
  const now = Date.now();
  if (now - lastProgressAt < 400) return;
  lastProgressAt = now;
  broadcast("playerProgress", {
    currentTime: main.currentTime,
    duration: Number.isFinite(main.duration) ? main.duration : 0,
  });
};

const handlers: Record<string, (payload?: unknown) => Promise<string>> = {
  play(payload) {
    return new Promise((resolve, reject) => {
      const { audioUri, rate } = payload as { audioUri: string; rate: number };
      if (!audioUri) {
        reject(new Error("No audioUri provided"));
        return;
      }

      // A newer play supersedes the pending one — settle it explicitly so the
      // transport's await resolves instead of dangling forever. The settle
      // closure is ownership-checked everywhere: a superseded play's late
      // callbacks must never null out the NEWER play's slot.
      settleCurrentPlay?.("interrupted");
      const settle = () => resolve("Playback interrupted");
      settleCurrentPlay = settle;
      mainPauseRequested = false;

      main.src = audioUri;
      main.playbackRate = rate || 1;

      main.onloadedmetadata = () => {
        if (mainPauseRequested) {
          // Paused before the audio ever started — park silently; the pending
          // promise stays open exactly like a pause after playback began.
          updateKeepalive();
          return;
        }
        main.play().catch((e) => {
          if (settleCurrentPlay !== settle) return; // superseded — already settled
          settleCurrentPlay = null;
          reject(new Error(`Error while trying to play audio: ${e}`));
        });
        updateKeepalive();
      };
      main.onerror = () => {
        if (settleCurrentPlay !== settle) return;
        settleCurrentPlay = null;
        main.removeAttribute("src");
        updateKeepalive();
        reject(new Error(`Error loading audio source: ${main.error?.message ?? "unknown"}`));
      };
      main.onended = () => {
        if (settleCurrentPlay === settle) settleCurrentPlay = null;
        updateKeepalive();
        resolve("Finished playing");
      };
    });
  },

  async stop() {
    settleCurrentPlay?.("interrupted");
    settleCurrentPlay = null;
    mainPauseRequested = false;
    // Detach handlers BEFORE unloading so the next play never receives a
    // stale event from this teardown.
    main.onloadedmetadata = null;
    main.onerror = null;
    main.onended = updateKeepalive;
    if (!main.paused) main.pause();
    main.removeAttribute("src");
    main.load();
    updateKeepalive();
    return "Stopped audio";
  },

  async pause() {
    // Remember the intent even when nothing is audibly playing yet — the
    // deferred autoplay in onloadedmetadata honors it.
    mainPauseRequested = true;
    if (!main.paused) main.pause();
    return "Paused";
  },

  async resume() {
    // After a long pause Chrome may have recycled this document; a fresh one
    // has no source. Reject so the transport can restart the current chunk.
    if (!main.src) throw new Error("Nothing loaded to resume");
    mainPauseRequested = false;
    await main.play();
    return "Resumed";
  },

  async seekBy(payload) {
    const { seconds } = payload as { seconds: number };
    // Reject rather than silently no-op: the transport must not record a
    // position for audio that isn't seekable (yet).
    if (!Number.isFinite(main.duration)) throw new Error("No seekable audio loaded");
    main.currentTime = Math.min(Math.max(main.currentTime + seconds, 0), main.duration);
    return "Seeked";
  },

  async seekTo(payload) {
    const { seconds } = payload as { seconds: number };
    if (!Number.isFinite(main.duration)) throw new Error("No seekable audio loaded");
    main.currentTime = Math.min(Math.max(seconds, 0), main.duration);
    return "Seeked";
  },

  async setRate(payload) {
    const { rate } = payload as { rate: number };
    main.playbackRate = rate;
    return "Rate set";
  },

  /** Current playback position — lets the background answer playerGetState
   *  with a live timeline when the popup reopens. */
  async getProgress() {
    return JSON.stringify({
      currentTime: main.currentTime,
      duration: Number.isFinite(main.duration) ? main.duration : 0,
    });
  },

  previewPlay(payload) {
    return new Promise((resolve, reject) => {
      const { audioUri } = payload as { audioUri: string };

      settleCurrentPreview?.("interrupted");
      settleCurrentPreview = () => resolve("Preview interrupted");

      preview.pause();
      preview.src = audioUri;
      preview.onended = () => {
        settleCurrentPreview = null;
        broadcast("previewEnded", {});
        resolve("Preview finished");
      };
      preview.onerror = () => {
        settleCurrentPreview = null;
        broadcast("previewEnded", {});
        reject(new Error("Preview failed to load"));
      };
      preview.play().catch((e) => {
        settleCurrentPreview = null;
        broadcast("previewEnded", {});
        reject(new Error(`Preview play failed: ${e}`));
      });
    });
  },

  async previewStop() {
    settleCurrentPreview?.("interrupted");
    settleCurrentPreview = null;
    preview.pause();
    preview.currentTime = 0;
    broadcast("previewEnded", {});
    return "Preview stopped";
  },
};

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
