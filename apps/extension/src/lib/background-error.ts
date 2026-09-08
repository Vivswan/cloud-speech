import { browser } from "#imports";
import { createDispatcher, type ErrorPayload, popupEvents } from "./protocol";

// ---------------------------------------------------------------------------
// The popup's error strip: one slot holding the last failure, fed by the
// background's `backgroundError` push (synthesis, previews, downloads) and by
// popup requests the background never answered (lib/player-actions.ts).
// Transient by design: playback and preview state live in storage.session and
// are watched; an error belongs to the popup that was open when it happened.
// ---------------------------------------------------------------------------

let current: ErrorPayload | null = null;
// Counts reports, so the banner can tell a repeat of the same failure from
// the one it already shows and start its dismissal over.
let sequence = 0;
// Outlives the banner: the failure the user is about to report has usually
// dismissed itself by the time they reach the Feedback view.
let lastReported: ErrorPayload | null = null;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function reportBackgroundError(error: ErrorPayload): void {
  current = error;
  lastReported = error;
  sequence += 1;
  notify();
}

/** How many errors have been reported; changes with every report. */
export function getBackgroundErrorSequence(): number {
  return sequence;
}

/** The most recent failure this popup saw, dismissed or not. */
export function getLastReportedError(): ErrorPayload | null {
  return lastReported;
}

export function clearBackgroundError(): void {
  if (current === null) return;
  current = null;
  notify();
}

export function getBackgroundError(): ErrorPayload | null {
  return current;
}

export function subscribeBackgroundError(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// One runtime.onMessage dispatcher for the popup, however many components
// listen: a second dispatcher would answer every event twice.
let dispatcherUsers = 0;
const dispatcher = createDispatcher("popup", popupEvents, {
  backgroundError: async (payload) => {
    reportBackgroundError(payload);
  },
});

/** Receive the background's pushed errors while the returned unsubscribe has
 *  not been called. */
export function listenForBackgroundErrors(): () => void {
  if (dispatcherUsers === 0) browser.runtime.onMessage.addListener(dispatcher);
  dispatcherUsers++;
  return () => {
    dispatcherUsers--;
    if (dispatcherUsers === 0) browser.runtime.onMessage.removeListener(dispatcher);
  };
}
