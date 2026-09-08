import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { VoicePicker } from "@/components/app/VoicePicker";
import type { VoiceModelRef } from "@/lib/storage";
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
const ROW_20: VoiceModelRef = { providerId: "azure", voiceId: "voice-20", model: "neural" };
const ROW_0: VoiceModelRef = { providerId: "polly", voiceId: "voice-0", model: "neural" };

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
          selection={ROW_0}
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

    // A press on the row auditioning is the same intent as any other press:
    // the background's slot turns it into a stop, and the button reads its
    // pressed state from the slot, never from a guess of its own.
    await act(async () => {
      await fakeBrowser.storage.session.set({ preview: ROW_20 });
    });
    const sent: unknown[] = [];
    fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
      sent.push(message);
    });
    await act(async () => {
      previewButtons()[21]?.click();
      previewButtons()[21]?.click();
    });
    const intent = {
      to: "background",
      id: "previewVoice",
      payload: { ...ROW_20, language: "en-US" },
    };
    expect(sent).toEqual([intent, intent]);
    expect(pressedIndexes()).toEqual([21]);
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

// The selection survives its provider's outage (nothing cached for that
// provider), so the trigger has no cached voice to describe. It describes the
// selection from its own fields and says why, instead of reading as empty.
describe("VoicePicker trigger during a provider outage", () => {
  const KEPT: VoiceModelRef = { providerId: "polly", voiceId: "Joanna", model: "standard" };
  const azureOnly = VOICES.filter((voice) => voice.providerId === "azure");

  function trigger(): HTMLButtonElement {
    const button = container.querySelector<HTMLButtonElement>("button[aria-haspopup]");
    if (!button) throw new Error("the picker did not render its trigger");
    return button;
  }

  it("shows the kept selection and the outage instead of the placeholder", async () => {
    await act(async () => {
      root.render(
        <VoicePicker
          voices={azureOnly}
          selection={KEPT}
          rosterUnknown
          favorites={[]}
          languageFilter="all"
          onSelect={() => {}}
          onToggleFavorite={() => {}}
        />,
      );
    });
    const text = trigger().textContent ?? "";
    expect(text).toContain("Joanna");
    expect(text).toContain("models.standard");
    expect(text).toContain("providers.polly.name");
    expect(text).toContain("preferences.voice_list_unavailable");
    expect(text).not.toContain("preferences.no_voices");
    // No cached voice, so nothing to audition from the trigger.
    expect(previewButtons()).toEqual([]);
  });

  // The provider's static roster lists one engine while a server may offer a
  // voice on others, so the kept selection always names its engine, even one
  // the roster does not know.
  it("names the kept selection's engine even when the provider roster lacks it", async () => {
    await act(async () => {
      root.render(
        <VoicePicker
          voices={azureOnly}
          selection={{ providerId: "custom", voiceId: "af_bella", model: "gpt-4o-mini-tts" }}
          rosterUnknown
          favorites={[]}
          languageFilter="all"
          onSelect={() => {}}
          onToggleFavorite={() => {}}
        />,
      );
    });
    const text = trigger().textContent ?? "";
    expect(text).toContain("af_bella");
    expect(text).toContain("gpt-4o-mini-tts");
  });

  it("control: the same uncached selection without the outage reads as no voice", async () => {
    await act(async () => {
      root.render(
        <VoicePicker
          voices={azureOnly}
          selection={KEPT}
          favorites={[]}
          languageFilter="all"
          onSelect={() => {}}
          onToggleFavorite={() => {}}
        />,
      );
    });
    expect(trigger().textContent).toContain("preferences.no_voices");
    expect(trigger().textContent).not.toContain("Joanna");
  });

  it("control: a cached selection keeps its full description", async () => {
    await act(async () => {
      root.render(
        <VoicePicker
          voices={VOICES}
          selection={ROW_0}
          rosterUnknown={false}
          favorites={[]}
          languageFilter="all"
          onSelect={() => {}}
          onToggleFavorite={() => {}}
        />,
      );
    });
    expect(trigger().textContent).toContain("Voice 0");
    expect(trigger().textContent).not.toContain("preferences.voice_list_unavailable");
    expect(previewButtons()).toHaveLength(1);
  });
});
