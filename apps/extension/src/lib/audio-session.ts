// Shared audio player, host-agnostic. It runs in whichever context can own
// media elements for the current browser:
//  - Chrome: the offscreen document (entrypoints/offscreen/main.ts), since
//    MV3 service workers cannot play audio.
//  - Firefox: the background event page itself (lib/audio-host.ts); there is
//    no offscreen API, and the background has a real DOM.
//
// Two independent channels: `main` for reads, `preview` for voice auditions
// (a preview must never interrupt an active read).
//
// Every handler returns a STRUCTURED promise result so failures reach the
// caller instead of silently becoming `undefined`. A pending `play` is
// explicitly settled ("interrupted") by stop or a newer play; its promise
// must never dangle when its media callbacks get overwritten.

/** Events the session raises toward its host (host decides the routing). */
export interface AudioSessionEvents {
  /** Periodic while audio is loaded; the host uses it to keep its execution
   *  context (Chrome service worker / Firefox event page) from idling out. */
  keepalive: undefined;
  /** The main audio reached its natural end. */
  playbackEnded: undefined;
  /** Throttled timeupdate for the mini-player timeline. */
  playerProgress: { currentTime: number; duration: number };
  /** The preview channel finished, failed, or was stopped. */
  previewEnded: Record<string, never>;
}

export type AudioSessionEmit = <K extends keyof AudioSessionEvents>(
  id: K,
  payload: AudioSessionEvents[K],
) => void;

export type AudioSessionHandlers = Record<string, (payload?: unknown) => Promise<string>>;

export function createAudioSession(emit: AudioSessionEmit): AudioSessionHandlers {
  // Created inside the factory: this module must stay import-safe from the
  // Chrome service worker, where `Audio` does not exist.
  const main = new Audio();
  const preview = new Audio();

  let settleCurrentPlay: ((outcome: "interrupted") => void) | null = null;
  let settleCurrentPreview: ((outcome: "interrupted") => void) | null = null;
  // A pause can arrive BEFORE the audio's metadata loads (main.paused is still
  // true then, so pause() alone can't stop the deferred autoplay). Remember the
  // intent and honor it when loadedmetadata fires.
  let mainPauseRequested = false;

  // Keepalive: while the main channel has audio loaded, ping the host so the
  // transport's in-memory state survives (Chrome MV3 workers idle out after
  // ~30s; Firefox suspends idle event pages similarly). The synthesis window
  // has its own keepalive in the transport.
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  function updateKeepalive(): void {
    // Active while audio is LOADED, even paused or finished. A parked read
    // (ended, still scrubbable) needs the transport state alive exactly as
    // much as a long pause does. `stop` clears the src.
    const active = main.src !== "";
    if (active && keepaliveTimer === undefined) {
      keepaliveTimer = setInterval(() => {
        emit("keepalive", undefined);
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
  // started via `resume` end OUTSIDE any pending play-promise, so this is the
  // only signal that reaches the transport for those.
  main.addEventListener("ended", () => {
    emit("playbackEnded", undefined);
  });

  // Throttled progress broadcast for the mini-player timeline.
  let lastProgressAt = 0;
  main.ontimeupdate = () => {
    const now = Date.now();
    if (now - lastProgressAt < 400) return;
    lastProgressAt = now;
    emit("playerProgress", {
      currentTime: main.currentTime,
      duration: Number.isFinite(main.duration) ? main.duration : 0,
    });
  };

  return {
    play(payload) {
      return new Promise((resolve, reject) => {
        const { audioUri, rate } = payload as { audioUri: string; rate: number };
        if (!audioUri) {
          reject(new Error("No audioUri provided"));
          return;
        }

        // A newer play supersedes the pending one; settle it explicitly so the
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
            // Paused before the audio ever started: park silently; the pending
            // promise stays open exactly like a pause after playback began.
            updateKeepalive();
            return;
          }
          main.play().catch((e) => {
            if (settleCurrentPlay !== settle) return; // superseded, already settled
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
      // Remember the intent even when nothing is audibly playing yet; the
      // deferred autoplay in onloadedmetadata honors it.
      mainPauseRequested = true;
      if (!main.paused) main.pause();
      return "Paused";
    },

    async resume() {
      // After a long pause the browser may have recycled this context; a fresh
      // one has no source. Reject so the transport can restart the chunk.
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

    /** Current playback position; lets the background answer playerGetState
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

        // Ownership-checked like the main channel: a superseded preview's
        // late play() rejection must never clear the NEWER preview's slot or
        // broadcast a stale previewEnded over it. (onended/onerror are
        // reassigned by the next previewPlay, so only the play() rejection
        // can arrive late.)
        settleCurrentPreview?.("interrupted");
        const settle = () => resolve("Preview interrupted");
        settleCurrentPreview = settle;

        preview.pause();
        preview.src = audioUri;
        preview.onended = () => {
          if (settleCurrentPreview === settle) settleCurrentPreview = null;
          emit("previewEnded", {});
          resolve("Preview finished");
        };
        preview.onerror = () => {
          if (settleCurrentPreview === settle) settleCurrentPreview = null;
          emit("previewEnded", {});
          reject(new Error("Preview failed to load"));
        };
        preview.play().catch((e) => {
          if (settleCurrentPreview !== settle) return; // superseded, already settled
          settleCurrentPreview = null;
          emit("previewEnded", {});
          reject(new Error(`Preview play failed: ${e}`));
        });
      });
    },

    async previewStop() {
      settleCurrentPreview?.("interrupted");
      settleCurrentPreview = null;
      preview.pause();
      preview.currentTime = 0;
      emit("previewEnded", {});
      return "Preview stopped";
    },
  };
}
