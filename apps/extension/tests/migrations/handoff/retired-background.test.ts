import { LEGACY_IDS } from "@cloud-speech/constants";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// The production background wired on a fork listing id, with the edges
// (providers, audio, voice fetch, i18n) mocked: proves the retired state
// reaches the menu rebuild, the menu clicks and the shortcut handler.

vi.mock("@/migrations", () => ({ runStartupMigrations: vi.fn(async () => {}) }));
vi.mock("@/migrations/handoff", () => ({
  importHandoffOnce: vi.fn(async () => {}),
  registerHandoff: vi.fn(),
}));
vi.mock("@/lib/i18n-runtime", () => ({
  i18n: { t: (key: string) => key },
  initI18n: vi.fn(async () => {}),
  subscribeLocale: vi.fn(),
}));
vi.mock("@/lib/voices", () => ({ fetchAllVoices: vi.fn(async () => []) }));
vi.mock("@/lib/errors", () => ({ surfaceError: vi.fn(async () => {}) }));
vi.mock("@/lib/audio-host", () => ({
  ensureAudioHost: vi.fn(async () => {}),
  sendToAudioHost: vi.fn(async () => "ok"),
  setAudioEventSink: vi.fn(),
}));
vi.mock("@/lib/transport", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/transport")>()),
  startReading: vi.fn(async () => true),
}));

import background from "@/entrypoints/background";
import { surfaceError } from "@/lib/errors";
import { subscribeLocale } from "@/lib/i18n-runtime";
import { startReading } from "@/lib/transport";
import { handoffBannerItem } from "@/migrations/handoff/state";

const menus = { removeAll: vi.fn(async () => {}), create: vi.fn() };
let onClicked: (info: { menuItemId: string; selectionText?: string }) => Promise<void>;
let onCommand: (command: string) => Promise<void>;

// Wired once, NO fakeBrowser.reset(): a reset would detach the background's
// listeners with no way to re-register them.
beforeAll(async () => {
  fakeBrowser.runtime.id = LEGACY_IDS[0] ?? "";
  Object.assign(fakeBrowser, {
    contextMenus: {
      ...menus,
      onClicked: {
        addListener: (listener: typeof onClicked) => {
          onClicked = listener;
        },
      },
    },
    commands: {
      onCommand: {
        addListener: (listener: typeof onCommand) => {
          onCommand = listener;
        },
      },
    },
  });
  background.main();
  await vi.waitFor(() => expect(menus.create).toHaveBeenCalledTimes(5));
});

describe("background on a fork install whose settings get taken", () => {
  it("removes the menus, skips rebuilds and turns clicks and shortcuts into no-ops", async () => {
    const localeChanged = vi.mocked(subscribeLocale).mock.calls[0]?.[0];
    if (!localeChanged) throw new Error("background did not subscribe to locale changes");

    // Control: before the import lands, the shortcut is live (no selection
    // in the fake browser, so it surfaces the "nothing selected" error).
    await onCommand("readAloudShortcut");
    expect(surfaceError).toHaveBeenCalledTimes(1);
    const removalsBefore = menus.removeAll.mock.calls.length;
    const menusBefore = menus.create.mock.calls.length;

    await handoffBannerItem.setValue({ imported: true, dismissedAt: null });
    await vi.waitFor(() => expect(menus.removeAll).toHaveBeenCalledTimes(removalsBefore + 1));

    localeChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(menus.create).toHaveBeenCalledTimes(menusBefore);

    vi.mocked(surfaceError).mockClear();
    await onCommand("readAloudShortcut");
    await onCommand("downloadShortcut");
    await onClicked({ menuItemId: "readAloud", selectionText: "hello" });
    expect(surfaceError).not.toHaveBeenCalled();
    expect(startReading).not.toHaveBeenCalled();
  });
});
