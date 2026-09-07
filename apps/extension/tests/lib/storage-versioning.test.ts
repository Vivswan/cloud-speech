import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  DEFAULT_SETTINGS,
  getSettings,
  readSettingsRecord,
  SETTINGS_VERSION,
  setSettings,
  updateSettingsWith,
} from "@/lib/storage";
import { SettingsNewerError } from "@/migrations";

// A blob a LATER build wrote: one version up, with a field this build does
// not know. (An OLDER blob is covered by the real upgrade chain in
// tests/migrations.)
const newerBlob = {
  ...DEFAULT_SETTINGS,
  schemaVersion: SETTINGS_VERSION + 1,
  speed: 3,
  laterField: "x",
};

describe("a stored blob from a newer build", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it("stays readable and rejects every write against it", async () => {
    await fakeBrowser.storage.sync.set({ settings: newerBlob });
    const set = vi.spyOn(fakeBrowser.storage.sync, "set");

    expect(await readSettingsRecord()).toEqual({
      settings: { ...DEFAULT_SETTINGS, speed: 3 },
      storedVersion: SETTINGS_VERSION + 1,
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
