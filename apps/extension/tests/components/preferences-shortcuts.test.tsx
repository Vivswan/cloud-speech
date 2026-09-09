import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Preferences } from "@/components/app/views/Preferences";
import { DEFAULT_SETTINGS } from "@/lib/storage";

// The shortcuts card follows the commands API: shown where the browser has
// keyboard shortcuts, gone where it has none (Firefox for Android), so the
// popup never lists an entry point that does not exist there.

const settings = {
  ...DEFAULT_SETTINGS,
  perProvider: {
    polly: {
      credentials: { accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" },
      verified: true,
      enabled: true,
    },
  },
};

// fakeBrowser.reset() does not bring a deleted namespace back, so the
// deletion is undone by hand after each test.
const commandsApi = fakeBrowser.commands;

beforeEach(async () => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
  await fakeBrowser.storage.sync.set({ settings });
});

afterEach(() => {
  (fakeBrowser as { commands?: unknown }).commands = commandsApi;
});

describe("Preferences shortcuts card", () => {
  it("control: lists the shortcuts where the commands API exists", async () => {
    // fakeBrowser's commands.getAll throws "not implemented" synchronously.
    const getAll = vi
      .spyOn(fakeBrowser.commands, "getAll")
      .mockImplementation((() =>
        Promise.resolve([{ name: "readAloudShortcut", shortcut: "Ctrl+Shift+S" }])) as never);
    render(<Preferences />);

    expect(await screen.findByText("settings.shortcuts_title")).toBeInTheDocument();
    expect(await screen.findByText("Ctrl+Shift+S")).toBeInTheDocument();
    expect(screen.getByText("settings.shortcut_read")).toBeInTheDocument();
    expect(screen.getByText("settings.shortcut_download")).toBeInTheDocument();
    expect(getAll).toHaveBeenCalledTimes(1);
  });

  it("hides the whole card, and asks nothing of the API, where the commands API is absent", async () => {
    delete (fakeBrowser as { commands?: unknown }).commands;
    render(<Preferences />);

    // The rest of the view renders as usual.
    expect(await screen.findByText("preferences.title")).toBeInTheDocument();
    expect(screen.queryByText("settings.shortcuts_title")).toBeNull();
    expect(screen.queryByText("settings.shortcut_read")).toBeNull();
    expect(screen.queryByText("settings.shortcut_download")).toBeNull();
    expect(screen.queryByText("settings.edit_shortcuts")).toBeNull();
    expect(screen.queryByText("settings.edit_shortcuts_firefox")).toBeNull();
  });
});
