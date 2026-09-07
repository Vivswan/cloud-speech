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

import type { z } from "zod";
import type { audioRoutes, backgroundRoutes, Handlers, Position } from "./protocol";

/** Events the session raises toward its host, in the shape of the background
 *  routes that carry them on Chrome (Firefox applies them in-process).
 *  Main-channel events are stamped with the epoch of the play (or resume)
 *  they belong to, so the playback document can reject events that outlive
 *  their read. Preview lifecycle events are deliberately absent: the
 *  BACKGROUND owns those (it observes previewPlay/previewStop settle). */
export type AudioSessionEventId = "keepalive" | "audioProgress" | "audioEnded";
export type AudioSessionEvents = {
  [K in AudioSessionEventId]: z.input<(typeof backgroundRoutes)[K]["payload"]>;
};

/** One listener per event the session raises, so a host that forgets one is
 *  a compile error. keepalive fires periodically while audio is loaded (the
 *  host keeps its execution context from idling out); audioEnded when the
 *  main audio reaches its natural end; audioProgress is the throttled
 *  timeupdate for the mini-player timeline. */
export type AudioSessionListeners = {
  [K in AudioSessionEventId]: (payload: AudioSessionEvents[K]) => void;
};

/** One handler per audio route, typed by the route table, so a payload or
 *  result mismatch is a compile error in whichever host wires it. */
export type AudioSessionHandlers = Handlers<typeof audioRoutes>;

/** Position ticks land in storage.session and fan out to every watcher, so
 *  they are throttled well below the element's ~4 Hz timeupdate. */
const PROGRESS_INTERVAL_MS = 1000;

export function createAudioSession(listeners: AudioSessionListeners): AudioSessionHandlers {
  // Created inside the factory: this module must stay import-safe from the
  // Chrome service worker, where `Audio` does not exist.
  const main = new Audio();
  const preview = new Audio();

  let settleCurrentPlay: ((outcome: "interrupted") => void) | null = null;
  let settleCurrentPreview: ((outcome: "interrupted") => void) | null = null;
  // A pause can arrive BEFORE the audio's metadata loads (main.paused is still
  // true then, so pause() alone can't stop the deferred autoplay), and even
  // before the play command itself when the transport published "playing"
  // while this context was still being created. Remember the intent and honor
  // it when loadedmetadata fires; only stop and resume clear it, since every
  // new read is preceded by a stop.
  let mainPauseRequested = false;
  // Playback epoch of the play/resume that owns the main channel; every
  // audioProgress/audioEnded event is stamped with it.
  let mainEpoch = 0;
  // Where the loading source starts once its duration is known: the play
  // command's startAt, or a seek that arrived while it was still loading.
  let pendingStart: number | null = null;

  // Keepalive: while the main channel has audio loaded, ping the host so its
  // execution context survives (Chrome MV3 workers idle out after ~30s;
  // Firefox suspends idle event pages similarly). The synthesis window has
  // its own keepalive in the transport.
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  function updateKeepalive(): void {
    // Active while audio is LOADED, even paused or finished. A parked read
    // (ended, still scrubbable) needs the host alive exactly as much as a
    // long pause does. `stop` clears the src.
    const active = main.src !== "";
    if (active && keepaliveTimer === undefined) {
      keepaliveTimer = setInterval(() => {
        listeners.keepalive(undefined);
      }, 20_000);
    } else if (!active && keepaliveTimer !== undefined) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
  }

  main.onplay = updateKeepalive;
  main.onpause = updateKeepalive;
  main.onended = updateKeepalive;

  /** Move the element to the pending start once its duration is known.
   *  Called before any position is read or reported, so the start the play
   *  (or a seek while loading) asked for is where the element IS, not where it
   *  will be after a loadedmetadata that has yet to dispatch. */
  function settlePendingStart(): void {
    if (pendingStart === null || !Number.isFinite(main.duration)) return;
    main.currentTime = Math.min(pendingStart, main.duration);
    pendingStart = null;
  }

  function positionOf(): Position {
    settlePendingStart();
    return {
      currentTime: main.currentTime,
      duration: Number.isFinite(main.duration) ? main.duration : 0,
    };
  }

  // Persistent (never reassigned): replays started via `resume` end OUTSIDE
  // any pending play-promise, so this is the only signal that reaches the
  // playback document for those.
  main.addEventListener("ended", () => {
    listeners.audioEnded({ epoch: mainEpoch, ...positionOf() });
  });

  let lastProgressAt = 0;
  main.ontimeupdate = () => {
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    listeners.audioProgress({ epoch: mainEpoch, ...positionOf() });
  };

  return {
    play(payload) {
      return new Promise((resolve, reject) => {
        const { audioUri, rate, epoch, startAt } = payload;
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
        mainEpoch = epoch;
        pendingStart = startAt ?? null;

        main.src = audioUri;
        main.playbackRate = rate || 1;

        main.onloadedmetadata = () => {
          settlePendingStart();
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
      pendingStart = null;
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
      // Before metadata (or with nothing loaded) the element has no position
      // to report; the caller keeps the one it already holds.
      return Number.isFinite(main.duration) ? positionOf() : null;
    },

    async resume(payload) {
      // The user's resume supersedes any earlier pause intent, loaded audio or
      // not: the replay the transport issues when nothing is loaded must not
      // inherit it.
      mainPauseRequested = false;
      // After a long pause the browser may have recycled this context; a fresh
      // one has no source. Reject so the transport can replay the read.
      if (!main.src) throw new Error("Nothing loaded to resume");
      mainEpoch = payload.epoch;
      await main.play();
      return "Resumed";
    },

    async seekTo(payload) {
      // Reject rather than silently no-op: the transport must not record a
      // position for audio that is not there.
      if (!main.src) throw new Error("No audio loaded");
      const seconds = Math.max(payload.seconds, 0);
      if (!Number.isFinite(main.duration)) {
        // Still loading: the seek becomes the start position (clamped once the
        // duration is known); 0 tells the caller the duration is unknown.
        pendingStart = seconds;
        return { currentTime: seconds, duration: 0 };
      }
      // A committed seek is the position now, whatever the play asked for
      // (the duration can be known before loadedmetadata has dispatched).
      pendingStart = null;
      main.currentTime = Math.min(seconds, main.duration);
      return positionOf();
    },

    async setRate(payload) {
      main.playbackRate = payload.rate;
      return "Rate set";
    },

    previewPlay(payload) {
      return new Promise((resolve, reject) => {
        const { audioUri } = payload;

        // Ownership-checked like the main channel: a superseded preview's
        // late play() rejection must never clear the NEWER preview's slot.
        // (onended/onerror are reassigned by the next previewPlay, so only
        // the play() rejection can arrive late.) The settled promise IS the
        // preview lifecycle signal the background acts on.
        settleCurrentPreview?.("interrupted");
        const settle = () => resolve("Preview interrupted");
        settleCurrentPreview = settle;

        preview.pause();
        preview.src = audioUri;
        preview.onended = () => {
          if (settleCurrentPreview === settle) settleCurrentPreview = null;
          resolve("Preview finished");
        };
        preview.onerror = () => {
          if (settleCurrentPreview === settle) settleCurrentPreview = null;
          reject(new Error("Preview failed to load"));
        };
        preview.play().catch((e) => {
          if (settleCurrentPreview !== settle) return; // superseded, already settled
          settleCurrentPreview = null;
          reject(new Error(`Preview play failed: ${e}`));
        });
      });
    },

    async previewStop() {
      settleCurrentPreview?.("interrupted");
      settleCurrentPreview = null;
      preview.pause();
      preview.currentTime = 0;
      return "Preview stopped";
    },
  };
}
