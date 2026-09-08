import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { VoicePicker } from "@/components/app/VoicePicker";
import { TooltipProvider } from "@/components/ui/tooltip";
import { describeFailure } from "@/lib/errors";
import { ProviderHttpError } from "@/lib/provider-http";
import type { VoiceModelRef } from "@/lib/storage";
import type { NormalizedVoice } from "@/providers/types";
import { sdkError } from "../helpers/sdk-error";

// The unavailable reason is read as shipped English, so the mock resolves the
// real en.yml instead of echoing key names.
vi.mock("@/lib/i18n-runtime", async () => (await import("../helpers/en-locale")).englishRuntime());

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
  return [...document.querySelectorAll<HTMLButtonElement>('button[title="Preview"]')];
}

function pressedIndexes(): number[] {
  return previewButtons().flatMap((button, index) =>
    button.getAttribute("aria-pressed") === "true" ? [index] : [],
  );
}

let container: HTMLElement;
let root: Root;

async function renderPicker(voices: NormalizedVoice[], selection: VoiceModelRef | null) {
  await act(async () => {
    root.render(
      <TooltipProvider>
        <VoicePicker
          voices={voices}
          selection={selection}
          favorites={[]}
          languageFilter="all"
          onSelect={() => {}}
          onToggleFavorite={() => {}}
        />
      </TooltipProvider>,
    );
  });
  const trigger = container.querySelector<HTMLButtonElement>("button[aria-haspopup]");
  if (!trigger) throw new Error("the picker did not render its trigger");
  await act(async () => {
    trigger.click();
  });
}

function issueButtons(): HTMLButtonElement[] {
  return [
    ...document.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="Show why this voice is unavailable"]',
    ),
  ];
}

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

    await renderPicker(VOICES, ROW_0);

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
    expect(text).toContain("Standard");
    expect(text).toContain("Amazon Polly");
    expect(text).toContain("Voice list unavailable, showing your last selection.");
    expect(text).not.toContain("No voices yet.");
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
    expect(trigger().textContent).toContain("No voices yet. Connect a provider in Settings first.");
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
    expect(trigger().textContent).not.toContain("Voice list unavailable");
    expect(previewButtons()).toHaveLength(1);
  });
});

// The cache holds each failure as the background described it at record
// time; the picker shows that description as it is. The fixtures are built
// by the same classifier the recorders use.
const GOOGLE_DISABLED_DETAIL =
  "Agent Platform API has not been used in project 176867167810 before or it is disabled. " +
  "Enable it by visiting https://console.developers.google.com/apis/api/aiplatform.googleapis.com/overview?project=176867167810 then retry. " +
  "If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.";
const GOOGLE_DISABLED = describeFailure(
  new ProviderHttpError("google", "synthesis", 403, GOOGLE_DISABLED_DETAIL),
  { providerId: "google" },
);
// The detail the user sees: the recorded text minus query strings, which can
// carry a key (the same redaction every notice applies).
const GOOGLE_DISABLED_SHOWN =
  "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403 " +
  `(${GOOGLE_DISABLED_DETAIL.replace("?project=176867167810 then", " then")})`;
// An AWS SDK failure has no HTTP shape of its own; only Polly reads it.
const POLLY_DENIED = describeFailure(sdkError("AccessDeniedException", 403), {
  providerId: "polly",
});
const UNRECOGNISED = describeFailure(new Error("the decoder gave up half way"), {
  providerId: "google",
});

const GEMINI: NormalizedVoice = {
  id: "Kore",
  providerId: "google",
  displayName: "Kore",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["gemini-2.5-flash-tts"],
};
const FINE: NormalizedVoice = {
  id: "voice-fine",
  providerId: "polly",
  displayName: "Fine",
  languageCodes: ["en-US"],
  gender: "Male",
  models: ["neural"],
};

/** Seed the cache as stored; `unknown`, so a test can plant a leaf no
 *  current build writes. */
async function flag(issues: unknown) {
  await act(async () => {
    await fakeBrowser.storage.local.set({ voiceIssues: issues });
  });
}

/** Pin the first flagged row's reason and return the panel that shows it. */
async function pinFirst(): Promise<HTMLElement> {
  const [button] = issueButtons();
  if (!button) throw new Error("the flagged row has no issue button");
  await act(async () => {
    button.click();
  });
  const pinned = document.querySelector("details")?.parentElement;
  if (!pinned) throw new Error("the pinned reason did not render");
  return pinned;
}

describe("VoicePicker unavailable reason", () => {
  it("explains a Google API-not-enabled row in plain words, with the console link and the raw text collapsed", async () => {
    await flag({ google: { Kore: { "gemini-2.5-flash-tts": GOOGLE_DISABLED } } });
    await renderPicker([FINE, GEMINI], null);

    const pinned = await pinFirst();
    expect(pinned).toHaveTextContent(
      "This voice needs the Agent Platform API switched on in your Google Cloud TTS account. " +
        "Turn it on, wait a minute, then try again.",
    );
    const link = pinned.querySelector("a");
    expect(link).toHaveTextContent("Fix it on the Google Cloud TTS website");
    expect(link).toHaveAttribute(
      "href",
      "https://console.developers.google.com/apis/api/aiplatform.googleapis.com/overview?project=176867167810",
    );
    const details = pinned.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent(GOOGLE_DISABLED_SHOWN);
    // The raw text is the detail, not the headline.
    expect(pinned.querySelector("p")).not.toHaveTextContent("ProviderHttpError");
  });

  it("explains a Polly row the SDK denied with the Polly sentence, the SDK's text collapsed", async () => {
    await flag({ polly: { "voice-fine": { neural: POLLY_DENIED } } });
    await renderPicker([FINE, GEMINI], null);

    const pinned = await pinFirst();
    expect(pinned).toHaveTextContent(
      "Your Amazon Polly key is not allowed to use speech. Give it permission in your " +
        "Amazon Polly account, or pick a voice from another provider.",
    );
    expect(pinned.querySelector("details")).toHaveTextContent(
      "AccessDeniedException: AccessDeniedException",
    );
    expect(pinned.querySelector("p")).not.toHaveTextContent("Something went wrong");
  });

  it("falls back to the generic sentence for a failure nothing classifies, keeping the raw text", async () => {
    await flag({ google: { Kore: { "gemini-2.5-flash-tts": UNRECOGNISED } } });
    await renderPicker([FINE, GEMINI], null);

    const pinned = await pinFirst();
    expect(pinned).toHaveTextContent("Something went wrong. Try again, or pick another voice.");
    expect(pinned.querySelector("a")).toBeNull();
    expect(pinned.querySelector("details")).toHaveTextContent(
      "Error: the decoder gave up half way",
    );
  });

  it("the tooltip carries the sentence alone: nothing focusable it would close on, and no issue button on an unflagged row", async () => {
    await flag({ google: { Kore: { "gemini-2.5-flash-tts": GOOGLE_DISABLED } } });
    await renderPicker([FINE, GEMINI], null);

    // One flagged row, one clean row: exactly one issue button, on the row
    // sunk into the Unavailable section.
    expect(issueButtons()).toHaveLength(1);
    expect(document.body).toHaveTextContent("Unavailable. Press play to retry.");

    const [button] = issueButtons();
    await act(async () => {
      button?.focus();
    });
    const tooltip = document.querySelector('[role="tooltip"]');
    expect(tooltip).toHaveTextContent(
      "This voice needs the Agent Platform API switched on in your Google Cloud TTS account. " +
        "Turn it on, wait a minute, then try again.",
    );
    expect(tooltip?.querySelector("a")).toBeNull();
    expect(tooltip?.querySelector("details")).toBeNull();
  });

  it("pinning another row starts with its Details collapsed, however the last one was left", async () => {
    // The same recorded failure on both rows: only the row's identity, not
    // the text shown, tells the panel it has a new occupant.
    await flag({
      polly: { "voice-fine": { neural: UNRECOGNISED } },
      google: { Kore: { "gemini-2.5-flash-tts": UNRECOGNISED } },
    });
    await renderPicker([FINE, GEMINI], null);
    const [first, second] = issueButtons();
    if (!first || !second) throw new Error("both flagged rows need an issue button");

    await act(async () => {
      first.click();
    });
    const opened = document.querySelector("details");
    if (!opened) throw new Error("the pinned reason did not render");
    opened.open = true;

    await act(async () => {
      second.click();
    });
    const pinned = document.querySelector("details")?.parentElement?.parentElement;
    expect(pinned).toHaveTextContent("Kore");
    expect(document.querySelector("details")?.open).toBe(false);
  });

  it("shows no mark for a leaf stored as the error's text, and no Unavailable section for it", async () => {
    await flag({
      google: {
        Kore: {
          "gemini-2.5-flash-tts": "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403",
        },
      },
    });
    await renderPicker([FINE, GEMINI], null);

    expect(issueButtons()).toHaveLength(0);
    expect(document.body).not.toHaveTextContent("Unavailable.");
  });

  it("renders no issue button when nothing is flagged", async () => {
    await renderPicker([FINE, GEMINI], null);
    expect(issueButtons()).toHaveLength(0);
    expect(document.body).not.toHaveTextContent("Unavailable.");
  });
});
