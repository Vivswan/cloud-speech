import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// A stand-in runner: the real registry is at SETTINGS_VERSION 1, so no stored
// blob can be "older than the code" yet. This stub lets a blob claim version 0
// with a `rate` field that the stub upgrade renames to `speed`, which is
// enough to observe storage's upgrade-on-read and write-back-once behavior.
vi.mock("@/migrations", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/migrations")>();
  const version = (raw: unknown) => {
    const v = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
    return typeof v === "number" ? v : 1;
  };
  return {
    ...actual,
    peekSchemaVersion: version,
    upgradeSettingsBlob: (raw: unknown) => {
      const v = version(raw);
      if (v > 1) throw new actual.SettingsNewerError(v);
      if (v === 1) return raw;
      const { rate, ...rest } = raw as { rate: number } & Record<string, unknown>;
      return { ...rest, speed: rate, schemaVersion: 1 };
    },
  };
});

import {
  DEFAULT_SETTINGS,
  getSettings,
  readSettingsRecord,
  setSettings,
  updateSettingsWith,
} from "@/lib/storage";
import { SettingsNewerError } from "@/migrations";

const { speed: _speed, ...defaultsWithoutSpeed } = DEFAULT_SETTINGS;
const olderBlob = { ...defaultsWithoutSpeed, schemaVersion: 0, rate: 2 };
const newerBlob = { ...DEFAULT_SETTINGS, schemaVersion: 2, speed: 3, laterField: "x" };

describe("stored blob versions", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it("upgrades an older blob on read and writes it back exactly once", async () => {
    await fakeBrowser.storage.sync.set({ settings: olderBlob });
    const set = vi.spyOn(fakeBrowser.storage.sync, "set");

    const [first, second] = await Promise.all([readSettingsRecord(), readSettingsRecord()]);
    expect(first).toEqual({ settings: { ...DEFAULT_SETTINGS, speed: 2 }, storedVersion: 0 });
    expect(second).toEqual(first);

    await vi.waitFor(async () => {
      expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual({
        ...DEFAULT_SETTINGS,
        speed: 2,
      });
    });
    expect(set).toHaveBeenCalledTimes(1);
    // The next read finds a current blob: nothing more to write.
    expect(await readSettingsRecord()).toEqual({
      settings: { ...DEFAULT_SETTINGS, speed: 2 },
      storedVersion: 1,
    });
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("keeps a newer blob readable and rejects every write against it", async () => {
    await fakeBrowser.storage.sync.set({ settings: newerBlob });
    const set = vi.spyOn(fakeBrowser.storage.sync, "set");

    expect(await readSettingsRecord()).toEqual({
      settings: { ...DEFAULT_SETTINGS, speed: 3 },
      storedVersion: 2,
    });
    expect((await getSettings()).speed).toBe(3);

    await expect(updateSettingsWith(() => ({ speed: 4 }))).rejects.toBeInstanceOf(
      SettingsNewerError,
    );
    await expect(setSettings(DEFAULT_SETTINGS)).rejects.toBeInstanceOf(SettingsNewerError);
    expect(set).not.toHaveBeenCalled();
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(newerBlob);
  });
});
