import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Preferences } from "@/components/app/views/Preferences";
import { DEFAULT_SETTINGS, voicesSessionItem } from "@/lib/storage";
import { polly } from "@/providers/polly";
import { DEFAULT_RANGES, type NormalizedVoice } from "@/providers/types";

// The selected voice's provider is unreachable and nothing of it is cached,
// while another provider's voices are. The selection is kept, so Preferences
// must size the prosody controls from the selection's own provider and
// engine, and the picker must describe the selection rather than read empty.

const joanna: NormalizedVoice = {
  id: "Joanna",
  providerId: "polly",
  displayName: "Joanna",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["standard", "neural"],
};

const jenny: NormalizedVoice = {
  id: "en-US-JennyNeural",
  providerId: "azure",
  displayName: "Jenny",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
};

const JOANNA_STANDARD = { providerId: "polly", voiceId: "Joanna", model: "standard" };

const bothConfigured = {
  ...DEFAULT_SETTINGS,
  perProvider: {
    polly: {
      credentials: { accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" },
      verified: true,
      enabled: true,
    },
    azure: {
      credentials: { subscriptionKey: "k", region: "eastus" },
      verified: true,
      enabled: true,
    },
    google: { credentials: { apiKey: "AIza-test" }, verified: true, enabled: true },
  },
  selection: JOANNA_STANDARD,
};

function speedThumb() {
  return screen.findByRole("slider", { name: "preferences.speed" });
}

async function speedSliderMax(): Promise<string | null> {
  return (await speedThumb()).getAttribute("aria-valuemax");
}

const pollySpeedMax = String(polly.ranges("standard").speed.max);

describe("Preferences with the selected voice's provider unreachable", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // fakeBrowser's commands.getAll throws "not implemented" synchronously.
    vi.spyOn(fakeBrowser.commands, "getAll").mockImplementation((() =>
      Promise.resolve([])) as never);
    await fakeBrowser.storage.sync.set({ settings: bothConfigured });
  });

  it("sizes the prosody controls from the selection's provider, not the defaults", async () => {
    await voicesSessionItem.setValue([jenny]);
    render(<Preferences />);

    expect(await speedSliderMax()).toBe(pollySpeedMax);
    expect(pollySpeedMax).not.toBe(String(DEFAULT_RANGES.speed.max));
    // Polly's standard engine takes pitch; the predicate answers from the
    // engine alone, so the control is there without the voice.
    expect(screen.getByRole("slider", { name: "preferences.pitch" })).toBeInTheDocument();
  });

  it("describes the kept selection in the picker and drops the empty-state note", async () => {
    await voicesSessionItem.setValue([jenny]);
    render(<Preferences />);

    const trigger = await screen.findByRole("button", { name: /Joanna/ });
    expect(trigger.textContent).toContain("preferences.voice_list_unavailable");
    expect(screen.queryByText("preferences.no_voices")).toBeNull();
  });

  it("with every provider out, the kept selection still hides the empty-state note", async () => {
    await voicesSessionItem.setValue([]);
    render(<Preferences />);

    await screen.findByRole("button", { name: /Joanna/ });
    expect(screen.queryByText("preferences.no_voices")).toBeNull();
    expect(await speedSliderMax()).toBe(pollySpeedMax);
    // The speed control follows the selection, not the size of the cache.
    expect(await speedThumb()).not.toHaveAttribute("data-disabled");
  });

  // Google knows the voices that take no pitch by name, so the predicates
  // must see the selection's voice id, not an unknown voice.
  it.each([
    { voiceId: "en-US-Studio-O", model: "standard", pitch: false },
    { voiceId: "en-US-Wavenet-A", model: "wavenet", pitch: true },
  ])(
    "asks the predicates about $voiceId by id: pitch control $pitch",
    async ({ voiceId, model, pitch }) => {
      await fakeBrowser.storage.sync.set({
        settings: { ...bothConfigured, selection: { providerId: "google", voiceId, model } },
      });
      await voicesSessionItem.setValue([jenny]);
      render(<Preferences />);

      await screen.findByRole("button", { name: new RegExp(voiceId) });
      await speedThumb();
      expect(screen.queryByRole("slider", { name: "preferences.pitch" }) !== null).toBe(pitch);
    },
  );

  it("control: the cached voice sizes the controls the same way", async () => {
    await voicesSessionItem.setValue([joanna, jenny]);
    render(<Preferences />);

    expect(await speedSliderMax()).toBe(pollySpeedMax);
    const trigger = await screen.findByRole("button", { name: /Joanna/ });
    expect(trigger.textContent).not.toContain("preferences.voice_list_unavailable");
  });

  it("control: no selection and no voices shows the empty-state note", async () => {
    await fakeBrowser.storage.sync.set({ settings: { ...bothConfigured, selection: null } });
    await voicesSessionItem.setValue([]);
    render(<Preferences />);

    // The note above the card and the picker's placeholder both say it.
    expect(await screen.findAllByText("preferences.no_voices")).toHaveLength(2);
  });
});
