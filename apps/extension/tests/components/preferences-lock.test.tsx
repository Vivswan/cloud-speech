import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Preferences } from "@/components/app/views/Preferences";
import { DEFAULT_SETTINGS, voicesSessionItem } from "@/lib/storage";
import type { NormalizedVoice } from "@/providers/types";
import { usePlayerStore } from "@/stores/player";

const joanna: NormalizedVoice = {
  id: "Joanna",
  providerId: "polly",
  displayName: "Joanna",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
};

const matthew: NormalizedVoice = {
  ...joanna,
  id: "Matthew",
  displayName: "Matthew",
  gender: "Male",
};

const pollySelected = {
  ...DEFAULT_SETTINGS,
  credentials: { polly: { accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" } },
  enabledProviders: { polly: true },
  selectedVoice: { providerId: "polly", voiceId: "Joanna" },
  model: "neural",
};

const newer = { ...pollySelected, schemaVersion: 2, laterField: "x" };

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

/** Another device saves a newer blob while the popup is open. */
async function lockWhileOpen() {
  await fakeBrowser.storage.sync.set({ settings: newer });
  expect(await screen.findByText("settings.storage_error_newer")).toBeInTheDocument();
}

/** ...and then puts a current one back (turned sync off and on again). */
async function unlock() {
  await fakeBrowser.storage.sync.set({ settings: pollySelected });
  await waitFor(() => expect(screen.queryByText("settings.storage_error_newer")).toBeNull());
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("Preferences under a newer build's settings", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // fakeBrowser's commands.getAll throws "not implemented" synchronously.
    vi.spyOn(fakeBrowser.commands, "getAll").mockImplementation((() =>
      Promise.resolve([])) as never);
    await voicesSessionItem.setValue([joanna, matthew]);
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
    await fakeBrowser.storage.sync.set({ settings: newer });
    const lock = vi.spyOn(navigator.locks, "request");
    render(<Preferences />);

    expect(await screen.findByText("settings.storage_error_newer")).toBeInTheDocument();
    await nudgeSpeedSlider();
    await settle();
    expect(lock).not.toHaveBeenCalled();
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(newer);
  });

  // The picker's list is portaled to <body>, outside the disabled fieldset:
  // without its own lock, favorites, auditions and picks kept working.
  it("voice picker open at the moment of the lock: its list closes for good and its buttons go inert", async () => {
    await fakeBrowser.storage.sync.set({ settings: pollySelected });
    const preview = vi.fn(() => Promise.resolve());
    usePlayerStore.setState({ preview });
    const lock = vi.spyOn(navigator.locks, "request");
    render(<Preferences />);

    fireEvent.click(await screen.findByText("Joanna"));
    expect(await screen.findAllByTitle("preferences.favorite")).toHaveLength(2);
    expect(screen.getByPlaceholderText("preferences.voice_search")).toBeInTheDocument();

    await lockWhileOpen();
    await waitFor(() => expect(screen.queryByTitle("preferences.favorite")).toBeNull());
    expect(screen.queryByPlaceholderText("preferences.voice_search")).toBeNull();
    expect(screen.queryByText("Matthew")).toBeNull();

    // What is left: the disabled trigger and the disabled audition button.
    const audition = screen.getByTitle("preferences.preview");
    expect(audition).toBeDisabled();
    fireEvent.click(audition);
    fireEvent.click(screen.getByText("Joanna"));
    await settle();
    expect(preview).not.toHaveBeenCalled();
    expect(screen.queryByTitle("preferences.favorite")).toBeNull();
    expect(lock).not.toHaveBeenCalled();
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(newer);

    // Unlocking does not resurrect the list the user never re-opened.
    await unlock();
    expect(screen.getByTitle("preferences.preview")).toBeEnabled();
    expect(screen.queryByTitle("preferences.favorite")).toBeNull();
  });

  it("select open at the moment of the lock: its list closes for good and nothing is written", async () => {
    await fakeBrowser.storage.sync.set({ settings: pollySelected });
    const lock = vi.spyOn(navigator.locks, "request");
    render(<Preferences />);

    const [languageSelect] = await screen.findAllByRole("combobox");
    if (!languageSelect) throw new Error("no select rendered");
    fireEvent.pointerDown(languageSelect, { button: 0, ctrlKey: false, pointerType: "mouse" });
    const options = await screen.findAllByRole("option");
    expect(options.length).toBeGreaterThan(1);

    await lockWhileOpen();
    await waitFor(() => expect(screen.queryAllByRole("option")).toHaveLength(0));

    fireEvent.pointerDown(languageSelect, { button: 0, ctrlKey: false, pointerType: "mouse" });
    await settle();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(lock).not.toHaveBeenCalled();
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(newer);

    await unlock();
    expect(languageSelect).toBeEnabled();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
  });
});
