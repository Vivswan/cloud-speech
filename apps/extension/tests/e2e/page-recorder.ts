import type { Playback } from "../../src/lib/playback";

// The popup page's own recorder, shared by the browser suites. Both functions
// run INSIDE the popup page, serialized by the harness's evaluate (Playwright
// on Chromium, Selenium on Firefox), so each is self-contained: nothing from
// this module's scope is referenced from within them.

/** What a popup page records about itself from the moment it loads, each
 *  entry stamped with the page's own Date.now(). Kept in the page, not read
 *  by polling from the test, so no transition is missed and no measurement
 *  depends on how late the test process gets to look. */
export interface PopupObservations {
  /** The error banner has been shown at least once. Starting a read or a
   *  preview from the popup clears the banner first, so a snapshot after the
   *  recovery action would miss one that a cancellation wrongly raised. */
  errorBannerSeen: boolean;
  /** Every playback document written while the page was open, in order. */
  playbackHistory: Array<{ at: number; doc: Playback }>;
  /** Every change of an audition row's pressed state, in order. */
  previewFlips: Array<{ at: number; pressed: boolean }>;
  /** Every runtime message another context sent while the page was open. On
   *  Chrome the offscreen document's position events travel this way; on
   *  Firefox nothing of the kind must. */
  envelopes: Array<{ at: number; to: unknown; id: unknown }>;
}

/** The extension API global the popup reaches its browser through. */
export type ExtensionApiGlobal = "browser" | "chrome";

export interface PopupRecorderOptions {
  api: ExtensionApiGlobal;
  /** The error banner's title text, whose presence in the page is "shown". */
  bannerTitle: string;
}

/** The parts of the extension API the recorder touches. */
type RecorderApi = {
  storage: {
    session: {
      onChanged: {
        addListener(
          listener: (changes: Record<string, { newValue?: unknown } | undefined>) => void,
        ): void;
      };
    };
  };
  runtime: { onMessage: { addListener(listener: (message: unknown) => void): void } };
};

/** Marionette runs each script in a fresh sandbox whose `window` is the real
 *  page global, so the recorder lives on `window` (never the sandbox's
 *  globalThis); in a Playwright page the two are the same object. */
type ObservedWindow = { observed?: PopupObservations };

export function installPopupRecorder({ api, bannerTitle }: PopupRecorderOptions): void {
  const extension = (window as unknown as Record<ExtensionApiGlobal, RecorderApi>)[api];
  const shown = () => document.body.innerText.includes(bannerTitle);
  const observed: PopupObservations = {
    errorBannerSeen: shown(),
    playbackHistory: [],
    previewFlips: [],
    envelopes: [],
  };
  (window as ObservedWindow).observed = observed;
  new MutationObserver((mutations) => {
    if (shown()) observed.errorBannerSeen = true;
    for (const mutation of mutations) {
      if (mutation.type !== "attributes" || mutation.oldValue === null) continue;
      const pressed = (mutation.target as Element).getAttribute("aria-pressed") === "true";
      if (pressed !== (mutation.oldValue === "true")) {
        observed.previewFlips.push({ at: Date.now(), pressed });
      }
    }
  }).observe(document.body, {
    subtree: true,
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["aria-pressed"],
    attributeOldValue: true,
  });
  extension.storage.session.onChanged.addListener((changes) => {
    const next = changes.playback?.newValue;
    if (next) observed.playbackHistory.push({ at: Date.now(), doc: next as Playback });
  });
  extension.runtime.onMessage.addListener((message) => {
    const envelope = (message ?? {}) as { to?: unknown; id?: unknown };
    observed.envelopes.push({ at: Date.now(), to: envelope.to, id: envelope.id });
  });
}

export function readPopupObservations(): PopupObservations {
  const observed = (window as ObservedWindow).observed;
  if (!observed) throw new Error("popup observations were never installed");
  return observed;
}
