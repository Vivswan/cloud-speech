import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { VoicePicker } from "@/components/app/VoicePicker";
import type { VoiceRef } from "@/lib/playback";
import type { NormalizedVoice } from "@/providers/types";

vi.mock("@/lib/i18n-runtime", () => ({
  i18n: { t: (key: string) => key },
  tDynamic: (key: string) => key,
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

// Two providers so the row list spans provider chips, one engine each so the
// row count equals the voice count.
const VOICES: NormalizedVoice[] = Array.from({ length: 30 }, (_, i) => ({
  id: `voice-${i}`,
  providerId: i < 15 ? "polly" : "azure",
  displayName: `Voice ${i}`,
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
}));
const ROW_20: VoiceRef = { providerId: "azure", voiceId: "voice-20", model: "neural" };
const ROW_0: VoiceRef = { providerId: "polly", voiceId: "voice-0", model: "neural" };

/** Every audition button in document order: the trigger's own button first,
 *  then one per list row in list order, so row N is index N + 1. */
function previewButtons(): HTMLButtonElement[] {
  return [...document.querySelectorAll<HTMLButtonElement>('button[title="preferences.preview"]')];
}

function pressedIndexes(): number[] {
  return previewButtons().flatMap((button, index) =>
    button.getAttribute("aria-pressed") === "true" ? [index] : [],
  );
}

let container: HTMLElement;
let root: Root;

beforeEach(() => {
  fakeBrowser.reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe("VoicePicker preview state", () => {
  it("subscribes to the preview slot once for the whole list and marks the auditioned row", async () => {
    const subscribe = vi.spyOn(fakeBrowser.storage.session.onChanged, "addListener");

    await act(async () => {
      root.render(
        <VoicePicker
          voices={VOICES}
          selected={{ providerId: "polly", voiceId: "voice-0" }}
          selectedModel="neural"
          favorites={[]}
          languageFilter="all"
          onSelect={() => {}}
          onToggleFavorite={() => {}}
        />,
      );
    });
    const trigger = container.querySelector<HTMLButtonElement>("button[aria-haspopup]");
    if (!trigger) throw new Error("the picker did not render its trigger");
    await act(async () => {
      trigger.click();
    });

    // The trigger's own audition button plus one per row, all fed by ONE watcher.
    expect(previewButtons()).toHaveLength(VOICES.length + 1);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(pressedIndexes()).toEqual([]);

    await act(async () => {
      await fakeBrowser.storage.session.set({ preview: ROW_20 });
    });
    expect(pressedIndexes()).toEqual([21]);

    // Auditioning the selected voice lights its row AND the trigger's button.
    await act(async () => {
      await fakeBrowser.storage.session.set({ preview: ROW_0 });
    });
    expect(pressedIndexes()).toEqual([0, 1]);

    await act(async () => {
      await fakeBrowser.storage.session.set({ preview: null });
    });
    expect(pressedIndexes()).toEqual([]);

    await act(async () => {
      root.unmount();
    });
    expect(fakeBrowser.storage.session.onChanged.hasListeners()).toBe(false);
  });
});
