// Host-agnostic audio player.
//   Chrome   -> the offscreen document (entrypoints/offscreen/main.ts); MV3 service workers cannot play audio
//   Firefox  -> the background event page itself (lib/audio/audio-host.ts); no offscreen API, but a real DOM
//
// Two channels, `main` for reads and `preview` for auditions: a preview must
// never interrupt a read.

import type { z } from "zod";
import type { audioRoutes, backgroundRoutes, Handlers, Position } from "../messaging/protocol";

/** Ticks land in storage.session and fan out to every watcher, so they stay well below the element's ~4 Hz timeupdate. */
const PROGRESS_INTERVAL_MS = 1000;

/** Inside Chrome MV3's ~30 s worker idle-out; Firefox suspends an idle event page too. */
const KEEPALIVE_INTERVAL_MS = 20_000;

/** Events toward the host, in the shape of the background routes that carry
 *  them on Chrome (Firefox applies them in-process). Preview lifecycle events
 *  are absent on purpose: the background owns those by observing
 *  previewPlay/previewStop settle. */
type AudioSessionEventId = "keepalive" | "audioProgress" | "audioEnded";
type AudioSessionEvents = {
  [K in AudioSessionEventId]: z.input<(typeof backgroundRoutes)[K]["payload"]>;
};

/** A host that forgets a listener is a compile error. keepalive fires while
 *  audio is loaded so the host's execution context does not idle out. */
export type AudioSessionListeners = {
  [K in AudioSessionEventId]: (payload: AudioSessionEvents[K]) => void;
};

export type AudioSessionHandlers = Handlers<typeof audioRoutes>;
type MainHandlers = Pick<
  AudioSessionHandlers,
  "play" | "stop" | "pause" | "resume" | "seekTo" | "setRate"
>;
type PreviewHandlers = Pick<AudioSessionHandlers, "previewPlay" | "previewStop">;

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
 *  loading      -> metadata pending
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

/** The preview channel: one audition at a time, its promise the lifecycle
 *  signal the background acts on. */
type PreviewState = { kind: "idle" } | { kind: "playing"; play: PendingPlay };

/** The main channel's element with the state its command handlers and element events share. */
interface MainChannel {
  readonly element: HTMLAudioElement;
  readonly listeners: AudioSessionListeners;
  state: MainState;
  keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  lastProgressAt: number;
}

/** The preview channel's element with its state. */
interface PreviewChannel {
  readonly element: HTMLAudioElement;
  state: PreviewState;
}

function isLoading(state: MainState): state is Loading {
  return state.kind === "loading" || state.kind === "loading-paused";
}

function isLoaded(state: MainState): state is Loaded {
  return state.kind !== "idle" && state.kind !== "idle-paused";
}

/** Every move of the main channel passes here, so the host keepalive follows the state: it runs
 *  while audio is loaded, paused or finished included (a parked read, ended but still scrubbable,
 *  needs the host alive as much as a long pause does), and stops once the channel is idle. The
 *  synthesis window has its own keepalive in the transport. */
function transition(channel: MainChannel, next: MainState): void {
  channel.state = next;
  const active = isLoaded(next);
  if (active && channel.keepaliveTimer === undefined) {
    channel.keepaliveTimer = setInterval(() => {
      channel.listeners.keepalive(undefined);
    }, KEEPALIVE_INTERVAL_MS);
  } else if (!active && channel.keepaliveTimer !== undefined) {
    clearInterval(channel.keepaliveTimer);
    channel.keepaliveTimer = undefined;
  }
}

/** While loading, the position is where the media WILL start, clamped once
 *  the duration is known; the element itself is still at 0. Duration 0
 *  tells the caller it is unknown. */
function positionOf(channel: MainChannel): Position {
  const { element, state } = channel;
  const known = Number.isFinite(element.duration);
  const duration = known ? element.duration : 0;
  const startAt = isLoading(state) ? state.startAt : null;

  if (startAt === null) return { currentTime: element.currentTime, duration };
  if (known) return { currentTime: Math.min(startAt, element.duration), duration };
  return { currentTime: startAt, duration };
}

/** The play() promise of a load is the one media callback that can outlive
 *  its state: a newer play or a stop rejects it with AbortError after the
 *  state has moved on, so it compares its PendingPlay with the state's. */
function failPlay(channel: MainChannel, play: PendingPlay, error: Error): void {
  const { state } = channel;
  if (!("play" in state) || state.play !== play) return;
  play.reject(error);
  transition(channel, { kind: "settled", epoch: state.epoch });
}

function wireMainElement(channel: MainChannel): void {
  const { element, listeners } = channel;

  element.onloadedmetadata = () => {
    const { state } = channel;
    if (!isLoading(state)) return;
    if (state.startAt !== null) element.currentTime = Math.min(state.startAt, element.duration);
    const { kind, epoch, play } = state;
    transition(channel, { kind: "ready", epoch, play });
    if (kind === "loading-paused") return;
    element.play().catch((e) => {
      failPlay(channel, play, new Error(`Error while trying to play audio: ${e}`));
    });
  };

  element.onerror = () => {
    const { state } = channel;
    if (!isLoaded(state)) return;
    if ("play" in state) {
      state.play.reject(
        new Error(`Error loading audio source: ${element.error?.message ?? "unknown"}`),
      );
    }
    element.removeAttribute("src");
    transition(channel, { kind: state.kind === "loading-paused" ? "idle-paused" : "idle" });
  };

  // Replays started via `resume` end OUTSIDE any pending play promise, so this
  // event is the only signal that reaches the playback document for those.
  element.onended = () => {
    const { state } = channel;
    if (!isLoaded(state)) return;
    listeners.audioEnded({ epoch: state.epoch, ...positionOf(channel) });
    if (state.kind !== "ready") return;
    state.play.resolve("Finished playing");
    transition(channel, { kind: "settled", epoch: state.epoch });
  };

  element.ontimeupdate = () => {
    const { state } = channel;
    if (!isLoaded(state)) return;
    const now = Date.now();
    if (now - channel.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    channel.lastProgressAt = now;
    listeners.audioProgress({ epoch: state.epoch, ...positionOf(channel) });
  };
}

function mainHandlers(channel: MainChannel): MainHandlers {
  const { element } = channel;
  return {
    play(payload) {
      return new Promise((resolve, reject) => {
        const { audioUri, rate, epoch, startAt } = payload;
        if (!audioUri) {
          reject(new Error("No audioUri provided"));
          return;
        }

        const { state } = channel;
        if ("play" in state) state.play.resolve("Playback interrupted");
        const paused = state.kind === "idle-paused" || state.kind === "loading-paused";
        transition(channel, {
          kind: paused ? "loading-paused" : "loading",
          epoch,
          play: { resolve, reject },
          startAt: startAt ?? null,
        });

        element.src = audioUri;
        element.playbackRate = rate || 1;
      });
    },

    async stop() {
      const { state } = channel;
      if ("play" in state) state.play.resolve("Playback interrupted");
      transition(channel, { kind: "idle" });
      if (!element.paused) element.pause();
      element.removeAttribute("src");
      element.load();
      return "Stopped audio";
    },

    async pause() {
      const { state } = channel;
      if (state.kind === "idle") transition(channel, { kind: "idle-paused" });
      else if (state.kind === "loading") transition(channel, { ...state, kind: "loading-paused" });
      if (!element.paused) element.pause();
      // Before metadata (or with nothing loaded) the element has no position
      // to report; the caller keeps the one it already holds.
      return Number.isFinite(element.duration) ? positionOf(channel) : null;
    },

    async resume(payload) {
      // After a long pause the browser may have recycled this context; a fresh
      // one has no source. Reject so the transport can replay the read, and
      // let the replay start unpaused.
      const { state } = channel;
      switch (state.kind) {
        case "idle-paused":
          transition(channel, { kind: "idle" });
          throw new Error("Nothing loaded to resume");
        case "idle":
          throw new Error("Nothing loaded to resume");
        case "loading-paused":
          transition(channel, { ...state, kind: "loading", epoch: payload.epoch });
          break;
        default:
          transition(channel, { ...state, epoch: payload.epoch });
          break;
      }
      await element.play();
      return "Resumed";
    },

    async seekTo(payload) {
      // Reject rather than silently no-op: the transport must not record a
      // position for audio that is not there.
      const { state } = channel;
      if (!isLoaded(state)) throw new Error("No audio loaded");
      const seconds = Math.max(payload.seconds, 0);
      if (isLoading(state)) {
        transition(channel, { ...state, startAt: seconds });
      } else {
        element.currentTime = Math.min(seconds, element.duration);
      }
      return positionOf(channel);
    },

    async setRate(payload) {
      element.playbackRate = payload.rate;
      return "Rate set";
    },
  };
}

/** The preview's play() promise can reject late the same way as the main channel's. */
function failPreview(preview: PreviewChannel, play: PendingPlay, error: Error): void {
  const { state } = preview;
  if (state.kind !== "playing" || state.play !== play) return;
  play.reject(error);
  preview.state = { kind: "idle" };
}

function wirePreviewElement(preview: PreviewChannel): void {
  const { element } = preview;

  element.onended = () => {
    const { state } = preview;
    if (state.kind !== "playing") return;
    state.play.resolve("Preview finished");
    preview.state = { kind: "idle" };
  };

  element.onerror = () => {
    const { state } = preview;
    if (state.kind !== "playing") return;
    state.play.reject(new Error("Preview failed to load"));
    preview.state = { kind: "idle" };
  };
}

function previewHandlers(preview: PreviewChannel): PreviewHandlers {
  const { element } = preview;
  return {
    previewPlay(payload) {
      return new Promise((resolve, reject) => {
        const { audioUri } = payload;
        const { state } = preview;
        if (state.kind === "playing") state.play.resolve("Preview interrupted");
        const play: PendingPlay = { resolve, reject };
        preview.state = { kind: "playing", play };

        element.pause();
        element.src = audioUri;
        element.play().catch((e) => {
          failPreview(preview, play, new Error(`Preview play failed: ${e}`));
        });
      });
    },

    async previewStop() {
      const { state } = preview;
      if (state.kind === "playing") state.play.resolve("Preview interrupted");
      preview.state = { kind: "idle" };
      element.pause();
      element.currentTime = 0;
      return "Preview stopped";
    },
  };
}

export function createAudioSession(listeners: AudioSessionListeners): AudioSessionHandlers {
  // Created inside the factory: this module must stay import-safe from the
  // Chrome service worker, where `Audio` does not exist.
  const main: MainChannel = {
    element: new Audio(),
    listeners,
    state: { kind: "idle" },
    keepaliveTimer: undefined,
    lastProgressAt: 0,
  };
  const preview: PreviewChannel = { element: new Audio(), state: { kind: "idle" } };

  wireMainElement(main);
  wirePreviewElement(preview);
  return { ...mainHandlers(main), ...previewHandlers(preview) };
}
