import { LEGACY_IDS } from "@cloud-speech/constants";
import { expect, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// Scaffolding for running the production background on a fork listing id
// with its edges (providers, audio, voice fetch, i18n) mocked. Import this
// module BEFORE the background so the mocks below are registered first. Each
// test file gets ONE background: its menu chain and retired flag live in
// module state, and fakeBrowser.reset() would detach its listeners for good.

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

import { surfaceError } from "@/lib/errors";
import { subscribeLocale } from "@/lib/i18n-runtime";
import { startReading } from "@/lib/transport";

/** The menus as the browser would hold them: create adds, removeAll clears. */
export const menuIds = new Set<string>();
export const menus = {
  removeAll: vi.fn(async () => {
    menuIds.clear();
  }),
  create: vi.fn((properties: { id: string }) => {
    menuIds.add(properties.id);
  }),
};

export const listeners = {
  onClicked: async (_info: { menuItemId: string; selectionText?: string }): Promise<void> => {
    throw new Error("background did not register a context menu click listener");
  },
  onCommand: async (_command: string): Promise<void> => {
    throw new Error("background did not register a command listener");
  },
};

/** Call before background.main(): the fork id and the menu/command APIs. */
export function wireForkBackground(): void {
  fakeBrowser.runtime.id = LEGACY_IDS[0] ?? "";
  Object.assign(fakeBrowser, {
    contextMenus: {
      ...menus,
      onClicked: {
        addListener: (listener: typeof listeners.onClicked) => {
          listeners.onClicked = listener;
        },
      },
    },
    commands: {
      onCommand: {
        addListener: (listener: typeof listeners.onCommand) => {
          listeners.onCommand = listener;
        },
      },
    },
  });
}

/** Fires the background's locale subscription, which queues a menu rebuild. */
export function localeChanged(): void {
  const listener = vi.mocked(subscribeLocale).mock.calls[0]?.[0];
  if (!listener) throw new Error("background did not subscribe to locale changes");
  listener();
}

/** Retired: shortcuts and menu clicks neither read nor surface an error. */
export async function expectNoOpHandlers(): Promise<void> {
  vi.mocked(surfaceError).mockClear();
  await listeners.onCommand("readAloudShortcut");
  await listeners.onCommand("downloadShortcut");
  await listeners.onClicked({ menuItemId: "readAloud", selectionText: "hello" });
  expect(surfaceError).not.toHaveBeenCalled();
  expect(startReading).not.toHaveBeenCalled();
}
