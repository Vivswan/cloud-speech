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

import type {
  OffscreenMessageId,
  OffscreenMessages,
  PlayerProgress,
  StampedPlayerProgress,
} from "./messages";

/** Events the session raises toward its host (host decides the routing).
 *  Main-channel events carry the transport generation of the play (or
 *  resume) they belong to, so the transport can reject events that outlive
 *  their read. Preview lifecycle events are deliberately absent: the
 *  BACKGROUND owns those (it observes previewPlay/previewStop settle) and
 *  broadcasts a keyed previewEnded itself. */
export interface AudioSessionEvents {
  /** Periodic while audio is loaded; the host uses it to keep its execution
   *  context (Chrome service worker / Firefox event page) from idling out. */
  keepalive: undefined;
  /** The main audio reached its natural end. */
  playbackEnded: { generation: number };
  /** Throttled timeupdate for the mini-player timeline. */
  playerProgress: StampedPlayerProgress;
}

export type AudioSessionEmit = <K extends keyof AudioSessionEvents>(
  id: K,
  payload: AudioSessionEvents[K],
) => void;

/** One handler per offscreen message, typed by the message contract (same
 *  payload-tuple convention as sendToAudioHost), so a payload or result
 *  mismatch is a compile error in whichever host wires it. */
export type AudioSessionHandlers = {
  [K in OffscreenMessageId]: (
    ...args: OffscreenMessages[K]["payload"] extends undefined
      ? []
      : [OffscreenMessages[K]["payload"]]
  ) => Promise<OffscreenMessages[K]["result"]>;
};

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
  // Transport generation of the play/resume that owns the main channel; every
  // playerProgress/playbackEnded event is stamped with it so the transport can
  // tell a live event from one that outlived its read.
  let mainGeneration = 0;

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
    emit("playbackEnded", { generation: mainGeneration });
  });

  function progressOf(): PlayerProgress {
    return {
      currentTime: main.currentTime,
      duration: Number.isFinite(main.duration) ? main.duration : 0,
    };
  }

  // Throttled progress broadcast for the mini-player timeline.
  let lastProgressAt = 0;
  main.ontimeupdate = () => {
    const now = Date.now();
    if (now - lastProgressAt < 400) return;
    lastProgressAt = now;
    emit("playerProgress", { generation: mainGeneration, ...progressOf() });
  };

  return {
    play(payload) {
      return new Promise((resolve, reject) => {
        const { audioUri, rate, generation } = payload;
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
        mainGeneration = generation;

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

    async resume(payload) {
      // After a long pause the browser may have recycled this context; a fresh
      // one has no source. Reject so the transport can restart the chunk.
      if (!main.src) throw new Error("Nothing loaded to resume");
      // The transport claims a fresh generation for the replay (orphaning the
      // original play-continuation); events from here on belong to it.
      mainGeneration = payload.generation;
      mainPauseRequested = false;
      await main.play();
      return "Resumed";
    },

    async seekBy(payload) {
      // Reject rather than silently no-op: the transport must not record a
      // position for audio that isn't seekable (yet).
      if (!Number.isFinite(main.duration)) throw new Error("No seekable audio loaded");
      main.currentTime = Math.min(Math.max(main.currentTime + payload.seconds, 0), main.duration);
      return progressOf();
    },

    async seekTo(payload) {
      if (!Number.isFinite(main.duration)) throw new Error("No seekable audio loaded");
      main.currentTime = Math.min(Math.max(payload.seconds, 0), main.duration);
      return progressOf();
    },

    async setRate(payload) {
      main.playbackRate = payload.rate;
      return "Rate set";
    },

    /** Live element position: backs playerGetState refreshes and the
     *  transport's commit points (pause/park), where the throttled
     *  playerProgress mirror can trail by up to 400ms. */
    async getProgress() {
      // Reject when nothing is loaded (recycled context): a zeroed reading
      // must not overwrite a position restored from the parked snapshot.
      if (!Number.isFinite(main.duration)) throw new Error("No audio loaded");
      return progressOf();
    },

    previewPlay(payload) {
      return new Promise((resolve, reject) => {
        const { audioUri } = payload;

        // Ownership-checked like the main channel: a superseded preview's
        // late play() rejection must never clear the NEWER preview's slot.
        // (onended/onerror are reassigned by the next previewPlay, so only
        // the play() rejection can arrive late.) The settled promise IS the
        // preview lifecycle signal; the background turns it into the keyed
        // previewEnded broadcast.
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
