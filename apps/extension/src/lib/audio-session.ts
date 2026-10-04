// Host-agnostic audio player.
//   Chrome   -> the offscreen document (entrypoints/offscreen/main.ts); MV3 service workers cannot play audio
//   Firefox  -> the background event page itself (lib/audio-host.ts); no offscreen API, but a real DOM
//
// Two channels, `main` for reads and `preview` for auditions: a preview must
// never interrupt a read.

import type { z } from "zod";
import type { audioRoutes, backgroundRoutes, Handlers, Position } from "./protocol";

/** Events toward the host, in the shape of the background routes that carry
 *  them on Chrome (Firefox applies them in-process). Preview lifecycle events
 *  are absent on purpose: the background owns those by observing
 *  previewPlay/previewStop settle. */
export type AudioSessionEventId = "keepalive" | "audioProgress" | "audioEnded";
export type AudioSessionEvents = {
  [K in AudioSessionEventId]: z.input<(typeof backgroundRoutes)[K]["payload"]>;
};

/** A host that forgets a listener is a compile error. keepalive fires while
 *  audio is loaded so the host's execution context does not idle out. */
export type AudioSessionListeners = {
  [K in AudioSessionEventId]: (payload: AudioSessionEvents[K]) => void;
};

export type AudioSessionHandlers = Handlers<typeof audioRoutes>;

/** Position ticks land in storage.session and fan out to every watcher, so
 *  they are throttled well below the element's ~4 Hz timeupdate. */
const PROGRESS_INTERVAL_MS = 1000;

/** The settlers of a play command's promise. The promise settles exactly once:
 *  the state that holds a PendingPlay is the only one that may settle it, and
 *  every transition out of such a state settles it or hands it on. */
type PendingPlay = {
  resolve: (outcome: string) => void;
  reject: (error: Error) => void;
};

/** The main channel. A pause reaching the channel before its media is ready
 *  is a state of its own, so the deferred autoplay has nothing to check: a
 *  `-paused` state parks on loadedmetadata. Once ready, the element owns playing vs paused.
 *
 *  idle-paused  -> the transport published "playing" and the user paused before the play command arrived
 *  loading      -> metadata pending; `startAt` (the play's, or a seek while loading) applies once the duration is known, null leaves the element where it is
 *  ready        -> settles its promise when the media ends or fails
 *  settled      -> the media stays scrubbable for seeks and a replaying resume
 *
 *  Position events carry the epoch of the play (or resume) that owns them. */
type MainState =
  | { kind: "idle" }
  | { kind: "idle-paused" }
  | { kind: "loading"; epoch: number; play: PendingPlay; startAt: number | null }
  | { kind: "loading-paused"; epoch: number; play: PendingPlay; startAt: number | null }
  | { kind: "ready"; epoch: number; play: PendingPlay }
  | { kind: "settled"; epoch: number };

type Loading = Extract<MainState, { kind: "loading" | "loading-paused" }>;
type Loaded = Exclude<MainState, { kind: "idle" | "idle-paused" }>;

function isLoading(state: MainState): state is Loading {
  return state.kind === "loading" || state.kind === "loading-paused";
}

function isLoaded(state: MainState): state is Loaded {
  return state.kind !== "idle" && state.kind !== "idle-paused";
}

/** The preview channel: one audition at a time, its promise the lifecycle
 *  signal the background acts on. */
type PreviewState = { kind: "idle" } | { kind: "playing"; play: PendingPlay };

export function createAudioSession(listeners: AudioSessionListeners): AudioSessionHandlers {
  // Created inside the factory: this module must stay import-safe from the
  // Chrome service worker, where `Audio` does not exist.
  const main = new Audio();
  const preview = new Audio();

  let state: MainState = { kind: "idle" };
  let previewState: PreviewState = { kind: "idle" };

  // While audio is loaded, ping the host so its context survives (Chrome MV3
  // workers idle out after ~30 s; Firefox suspends idle event pages). Active
  // even paused or finished: a parked read (ended, still scrubbable) needs the
  // host alive as much as a long pause does. The synthesis window has its own
  // keepalive in the transport.
  let keepaliveTimer: ReturnType<typeof setInterval> | undefined;

  function transition(next: MainState): void {
    state = next;
    const active = isLoaded(state);
    if (active && keepaliveTimer === undefined) {
      keepaliveTimer = setInterval(() => {
        listeners.keepalive(undefined);
      }, 20_000);
    } else if (!active && keepaliveTimer !== undefined) {
      clearInterval(keepaliveTimer);
      keepaliveTimer = undefined;
    }
  }

  /** While loading, the position is where the media WILL start, clamped once
   *  the duration is known; the element itself is still at 0. Duration 0
   *  tells the caller it is unknown. */
  function positionOf(): Position {
    const known = Number.isFinite(main.duration);
    const startAt = isLoading(state) ? state.startAt : null;
    return {
      currentTime:
        startAt === null ? main.currentTime : known ? Math.min(startAt, main.duration) : startAt,
      duration: known ? main.duration : 0,
    };
  }

  /** The play() promise of a load is the one media callback that can outlive
   *  its state: a newer play or a stop rejects it with AbortError after the
   *  state has moved on, so it compares its PendingPlay with the state's. */
  function failPlay(play: PendingPlay, error: Error): void {
    if (!("play" in state) || state.play !== play) return;
    play.reject(error);
    transition({ kind: "settled", epoch: state.epoch });
  }

  main.onloadedmetadata = () => {
    if (!isLoading(state)) return;
    if (state.startAt !== null) main.currentTime = Math.min(state.startAt, main.duration);
    const { kind, epoch, play } = state;
    transition({ kind: "ready", epoch, play });
    if (kind === "loading-paused") return;
    main.play().catch((e) => {
      failPlay(play, new Error(`Error while trying to play audio: ${e}`));
    });
  };

  main.onerror = () => {
    if (!isLoaded(state)) return;
    if ("play" in state) {
      state.play.reject(
        new Error(`Error loading audio source: ${main.error?.message ?? "unknown"}`),
      );
    }
    main.removeAttribute("src");
    transition({ kind: state.kind === "loading-paused" ? "idle-paused" : "idle" });
  };

  // Replays started via `resume` end OUTSIDE any pending play promise, so this
  // event is the only signal that reaches the playback document for those.
  main.onended = () => {
    if (!isLoaded(state)) return;
    listeners.audioEnded({ epoch: state.epoch, ...positionOf() });
    if (state.kind !== "ready") return;
    state.play.resolve("Finished playing");
    transition({ kind: "settled", epoch: state.epoch });
  };

  let lastProgressAt = 0;
  main.ontimeupdate = () => {
    if (!isLoaded(state)) return;
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    listeners.audioProgress({ epoch: state.epoch, ...positionOf() });
  };

  /** The preview's play() promise can reject late the same way. */
  function failPreview(play: PendingPlay, error: Error): void {
    if (previewState.kind !== "playing" || previewState.play !== play) return;
    play.reject(error);
    previewState = { kind: "idle" };
  }

  preview.onended = () => {
    if (previewState.kind !== "playing") return;
    previewState.play.resolve("Preview finished");
    previewState = { kind: "idle" };
  };

  preview.onerror = () => {
    if (previewState.kind !== "playing") return;
    previewState.play.reject(new Error("Preview failed to load"));
    previewState = { kind: "idle" };
  };

  return {
    play(payload) {
      return new Promise((resolve, reject) => {
        const { audioUri, rate, epoch, startAt } = payload;
        if (!audioUri) {
          reject(new Error("No audioUri provided"));
          return;
        }

        if ("play" in state) state.play.resolve("Playback interrupted");
        const paused = state.kind === "idle-paused" || state.kind === "loading-paused";
        transition({
          kind: paused ? "loading-paused" : "loading",
          epoch,
          play: { resolve, reject },
          startAt: startAt ?? null,
        });

        main.src = audioUri;
        main.playbackRate = rate || 1;
      });
    },

    async stop() {
      if ("play" in state) state.play.resolve("Playback interrupted");
      transition({ kind: "idle" });
      if (!main.paused) main.pause();
      main.removeAttribute("src");
      main.load();
      return "Stopped audio";
    },

    async pause() {
      if (state.kind === "idle") transition({ kind: "idle-paused" });
      else if (state.kind === "loading") transition({ ...state, kind: "loading-paused" });
      if (!main.paused) main.pause();
      // Before metadata (or with nothing loaded) the element has no position
      // to report; the caller keeps the one it already holds.
      return Number.isFinite(main.duration) ? positionOf() : null;
    },

    async resume(payload) {
      // After a long pause the browser may have recycled this context; a fresh
      // one has no source. Reject so the transport can replay the read, and
      // let the replay start unpaused.
      switch (state.kind) {
        case "idle-paused":
          transition({ kind: "idle" });
          throw new Error("Nothing loaded to resume");
        case "idle":
          throw new Error("Nothing loaded to resume");
        case "loading-paused":
          transition({ ...state, kind: "loading", epoch: payload.epoch });
          break;
        default:
          transition({ ...state, epoch: payload.epoch });
          break;
      }
      await main.play();
      return "Resumed";
    },

    async seekTo(payload) {
      // Reject rather than silently no-op: the transport must not record a
      // position for audio that is not there.
      if (!isLoaded(state)) throw new Error("No audio loaded");
      const seconds = Math.max(payload.seconds, 0);
      if (isLoading(state)) {
        transition({ ...state, startAt: seconds });
      } else {
        main.currentTime = Math.min(seconds, main.duration);
      }
      return positionOf();
    },

    async setRate(payload) {
      main.playbackRate = payload.rate;
      return "Rate set";
    },

    previewPlay(payload) {
      return new Promise((resolve, reject) => {
        const { audioUri } = payload;
        if (previewState.kind === "playing") previewState.play.resolve("Preview interrupted");
        const play: PendingPlay = { resolve, reject };
        previewState = { kind: "playing", play };

        preview.pause();
        preview.src = audioUri;
        preview.play().catch((e) => {
          failPreview(play, new Error(`Preview play failed: ${e}`));
        });
      });
    },

    async previewStop() {
      if (previewState.kind === "playing") previewState.play.resolve("Preview interrupted");
      previewState = { kind: "idle" };
      preview.pause();
      preview.currentTime = 0;
      return "Preview stopped";
    },
  };
}
