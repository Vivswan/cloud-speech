import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Preferences } from "@/components/app/views/Preferences";
import { DEFAULT_SETTINGS, voicesSessionItem } from "@/lib/storage";
import type { NormalizedVoice } from "@/providers/types";

const joanna: NormalizedVoice = {
  id: "Joanna",
  providerId: "polly",
  displayName: "Joanna",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
};

const pollySelected = {
  ...DEFAULT_SETTINGS,
  credentials: { polly: { accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" } },
  enabledProviders: { polly: true },
  selectedVoice: { providerId: "polly", voiceId: "Joanna" },
  model: "neural",
};

/** Focus the speed slider's thumb and nudge it one step with the keyboard;
 *  Radix commits keyboard changes immediately, so a writable slider produces
 *  exactly one settings write. Every write attempt, accepted or refused by
 *  storage, goes through the settings Web Lock, so spying on
 *  navigator.locks.request tells an attempt apart from a rejection. */
async function nudgeSpeedSlider() {
  const thumb = await screen.findByRole("slider", { name: "preferences.speed" });
  thumb.focus();
  fireEvent.keyDown(thumb, { key: "ArrowRight" });
}

describe("Preferences under a newer build's settings", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // fakeBrowser's commands.getAll throws "not implemented" synchronously.
    vi.spyOn(fakeBrowser.commands, "getAll").mockImplementation((() =>
      Promise.resolve([])) as never);
    await voicesSessionItem.setValue([joanna]);
  });

  it("writable control: the keyboard nudge reaches storage", async () => {
    await fakeBrowser.storage.sync.set({ settings: pollySelected });
    const lock = vi.spyOn(navigator.locks, "request");
    render(<Preferences />);

    await nudgeSpeedSlider();
    await waitFor(() => expect(lock).toHaveBeenCalledTimes(1));
    await waitFor(async () => {
      const stored = (await fakeBrowser.storage.sync.get("settings")) as {
        settings: { speed: number };
      };
      expect(stored.settings.speed).toBeGreaterThan(1);
    });
  });

  it("locked: the note shows, and the keyboard nudge never attempts a write", async () => {
    const newer = { ...pollySelected, schemaVersion: 2, laterField: "x" };
    await fakeBrowser.storage.sync.set({ settings: newer });
    const lock = vi.spyOn(navigator.locks, "request");
    render(<Preferences />);

    expect(await screen.findByText("settings.storage_error_newer")).toBeInTheDocument();
    await nudgeSpeedSlider();
    // Let any scheduled write settle before asserting none was attempted.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lock).not.toHaveBeenCalled();
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(newer);
  });
});
