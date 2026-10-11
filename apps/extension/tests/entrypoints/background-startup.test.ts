import { beforeAll, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// Its own file: the startup runs once per background, so a background whose startup lost a storage
// write cannot share a file with tests that read notices off a background that started clean.

vi.mock("@/migrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/migrations")>()),
  runStartupMigrations: vi.fn(async () => {}),
}));
vi.mock("@/lib/text/i18n-runtime", () => ({
  i18n: { t: (key: string) => key },
  initI18n: vi.fn(async () => {}),
  subscribeLocale: vi.fn(),
}));
vi.mock("@/lib/settings/voices", () => ({ fetchAllVoices: vi.fn(async () => []) }));
vi.mock("@/lib/audio/audio-host", () => ({
  ensureAudioHost: vi.fn(async () => {}),
  sendToAudioHost: vi.fn(async () => "ok"),
}));

import background from "@/entrypoints/background";
import { sendToAudioHost } from "@/lib/audio/audio-host";
import { IDLE_PLAYBACK, readPlayback } from "@/lib/audio/playback";

const toPopup: unknown[] = [];
const toTab = vi.fn(async (_tabId: number, _envelope: unknown) => undefined);
const warned = vi.spyOn(console, "warn").mockImplementation(() => {});

beforeAll(() => {
  Object.assign(fakeBrowser, {
    contextMenus: {
      removeAll: vi.fn(async () => {}),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
  });
  Object.assign(fakeBrowser.tabs, {
    query: vi.fn(async () => [{ id: 7 }]),
    sendMessage: toTab,
  });
  fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
    const envelope = message as { to?: string; id?: string; payload?: unknown };
    if (envelope.to === "popup" && envelope.id === "backgroundError")
      toPopup.push(envelope.payload);
  });
  // The only session-storage remove at startup is the preview clear. It rejects, as the area does
  // when it is unavailable.
  vi.spyOn(fakeBrowser.storage.session, "remove").mockRejectedValueOnce(
    new Error("Access to storage is not allowed from this context"),
  );
  background.main();
});

it("a session write rejected during startup is a warning, not a notice, and does not leave every route rejecting", async () => {
  expect(await fakeBrowser.runtime.sendMessage({ to: "background", id: "stopReading" })).toEqual({
    ok: true,
    value: true,
  });

  expect(warned).toHaveBeenCalledWith(
    "Clearing the preview row failed: Error: Access to storage is not allowed from this context",
  );
  expect(toPopup).toEqual([]);
  expect(toTab).not.toHaveBeenCalled();
  expect(vi.mocked(sendToAudioHost).mock.calls.map(([id]) => id)).toEqual(["stop"]);
  expect(await readPlayback()).toEqual(IDLE_PLAYBACK);
});
