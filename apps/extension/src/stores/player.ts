import { create } from "zustand";
import { browser } from "#imports";
import type { ErrorPayload, PlayerProgress, PlayerState, RuntimeMessage } from "@/lib/messages";
import { sendToBackground } from "@/lib/messages";
import type { ProviderId } from "@/providers/types";

// ---------------------------------------------------------------------------
// Player store — the popup's live mirror of the background transport plus the
// offscreen progress stream. Actions are thin wrappers over messages.
// ---------------------------------------------------------------------------

interface PlayerStore extends PlayerState, PlayerProgress {
  previewingKey: string | null;
  /** Last error surfaced by the background — shown as a popup banner. */
  lastError: ErrorPayload | null;
  /** True once the mount refresh() has settled. */
  hydrated: boolean;
  clearError: () => void;

  refresh: () => Promise<void>;
  play: (text: string, speed?: number) => Promise<void>;
  stop: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  seekBy: (seconds: number) => Promise<void>;
  seekTo: (seconds: number) => Promise<void>;
  setRate: (rate: number) => Promise<void>;
  preview: (key: string, payload: Parameters<typeof previewMessage>[0]) => Promise<void>;
  stopPreview: () => Promise<void>;
}

function previewMessage(payload: {
  providerId: ProviderId;
  voiceId: string;
  model: string;
  language?: string;
}) {
  return sendToBackground("previewVoice", payload);
}

// A progress broadcast can be in flight when the user commits a seek — for a
// short window afterwards, position updates are ignored so the thumb doesn't
// snap back to the pre-seek time it just left. `seekSeq` gives each seek
// ownership: a stale failed seek must not clear a newer seek's guard.
let seekGuardUntil = 0;
let seekSeq = 0;

export const usePlayerStore = create<PlayerStore>((set, get) => ({
  status: "idle",
  rate: 1,
  textDigest: null,
  currentTime: 0,
  duration: 0,
  previewingKey: null,
  lastError: null,
  // False until the first playerGetState round-trip settles — the player
  // controls must not act on the default "idle" of an unhydrated store.
  hydrated: false,
  clearError: () => set({ lastError: null }),

  refresh: async () => {
    const state = await sendToBackground("playerGetState").catch(() => null);
    if (state) set({ ...state, hydrated: true });
    else set({ hydrated: true });
  },
  play: async (text, speed) => {
    set({ lastError: null });
    await sendToBackground("readAloud", { text, speed });
  },
  stop: async () => {
    await sendToBackground("stopReading");
  },
  pause: async () => {
    await sendToBackground("playerPause");
  },
  resume: async () => {
    await sendToBackground("playerResume");
  },
  seekBy: async (seconds) => {
    // Delegate to seekTo: the relative seek gets the same optimistic thumb,
    // seek-guard ownership, and failure re-sync as an absolute one — without
    // it, the confirming progress event would be suppressed by an active
    // guard and the thumb would appear dead while paused.
    const { currentTime, duration } = get();
    await get().seekTo(Math.min(Math.max(currentTime + seconds, 0), duration || 0));
  },
  seekTo: async (seconds) => {
    // Optimistic: keep the thumb where the user dropped it (and hold off
    // in-flight progress broadcasts) until playback confirms the position.
    const mySeq = ++seekSeq;
    seekGuardUntil = Date.now() + 800;
    set({ currentTime: seconds });
    const ok = await sendToBackground("playerSeekTo", { seconds }).catch(() => false);
    // On failure of the LATEST seek, re-sync from the background — it is the
    // only authoritative position (a locally captured "before" could itself
    // be another seek's optimistic value). Ownership is re-checked around the
    // fetch too: a newer seek started mid-await must not be overwritten.
    if (ok !== true && seekSeq === mySeq) {
      seekGuardUntil = 0;
      const state = await sendToBackground("playerGetState").catch(() => null);
      if (state && seekSeq === mySeq) set(state);
    }
  },
  setRate: async (rate) => {
    set({ rate });
    await sendToBackground("playerSetRate", { rate });
  },
  preview: async (key, payload) => {
    const current = get().previewingKey;
    if (current === key) {
      await get().stopPreview();
      return;
    }
    set({ previewingKey: key, lastError: null });
    try {
      // The router maps handler errors to an `undefined` response — treat any
      // non-true result as failure so the row never stays stuck "auditioning".
      const ok = await previewMessage(payload);
      // Only clear if this request still owns the state — a newer preview may
      // have started while this one settled.
      if (ok !== true && get().previewingKey === key) set({ previewingKey: null });
    } catch {
      if (get().previewingKey === key) set({ previewingKey: null });
    }
  },
  stopPreview: async () => {
    set({ previewingKey: null });
    await sendToBackground("stopPreview").catch(() => {});
  },
}));

// Live updates from background/offscreen broadcasts.
browser.runtime.onMessage.addListener((message: RuntimeMessage) => {
  if (message?.id === "playerState") {
    const state = message.payload as PlayerState;
    // A reset means the audio the pending seek targeted is gone — the
    // optimistic position is meaningless; take the full zeroed state.
    if (state.status === "idle") seekGuardUntil = 0;
    if (Date.now() < seekGuardUntil) {
      // Same guard as progress: a state broadcast can carry a pre-seek
      // position too — take everything except currentTime.
      const { currentTime: _stale, ...rest } = state;
      usePlayerStore.setState(rest);
    } else {
      usePlayerStore.setState(state);
    }
  } else if (message?.id === "playerProgress") {
    const progress = message.payload as PlayerProgress;
    if (Date.now() < seekGuardUntil) {
      // Mid-seek: take the duration (harmless) but not the stale position.
      usePlayerStore.setState({ duration: progress.duration });
    } else {
      usePlayerStore.setState(progress);
    }
  } else if (message?.id === "previewEnded") {
    usePlayerStore.setState({ previewingKey: null });
  } else if (message?.id === "backgroundError") {
    usePlayerStore.setState({ lastError: message.payload as ErrorPayload });
  }
});
