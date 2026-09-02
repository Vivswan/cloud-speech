import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  DEFAULT_SETTINGS,
  discardSettingsBackup,
  getSettings,
  importBackupItem,
  restoreSettingsBackup,
  type Settings,
  SettingsSchema,
  salvageSettings,
  salvageSettingsPatch,
  setSettings,
  setSettingsWithBackup,
  setSyncEnabled,
  syncEnabledItem,
  updateSettings,
  updateSettingsWith,
} from "@/lib/storage";

describe("salvageSettings", () => {
  it("keeps every valid field when one field is corrupt", () => {
    const salvaged = salvageSettings({
      ...DEFAULT_SETTINGS,
      credentials: { polly: { accessKeyId: "KEEP" } },
      speed: "corrupt-not-a-number",
    });
    expect(salvaged.credentials.polly?.accessKeyId).toBe("KEEP");
    expect(salvaged.speed).toBe(DEFAULT_SETTINGS.speed);
  });
});

describe("salvageSettingsPatch", () => {
  it("patches only keys present in the raw object", () => {
    const { patch, dropped } = salvageSettingsPatch({ speed: 2 });
    expect(patch).toEqual({ speed: 2 });
    expect(dropped).toEqual([]);
  });

  it("reports present-but-unusable keys as dropped", () => {
    const { patch, dropped } = salvageSettingsPatch({ speed: "corrupt", pitch: 5 });
    expect(patch).toEqual({ pitch: 5 });
    expect(dropped).toEqual(["speed"]);
  });

  it("rescues valid record entries and flags the lossy key", () => {
    const { patch, dropped } = salvageSettingsPatch({
      credentials: { polly: { accessKeyId: "KEEP" }, azure: 42 },
    });
    expect(patch.credentials).toEqual({ polly: { accessKeyId: "KEEP" } });
    expect(dropped).toEqual(["credentials"]);
  });

  it("drops a record key with nothing usable, without patching it", () => {
    const { patch, dropped } = salvageSettingsPatch({ credentials: { polly: 42 } });
    expect("credentials" in patch).toBe(false);
    expect(dropped).toEqual(["credentials"]);
  });

  it("reports nothing dropped for fully valid input", () => {
    const { patch, dropped } = salvageSettingsPatch(DEFAULT_SETTINGS);
    expect(patch).toEqual(DEFAULT_SETTINGS);
    expect(dropped).toEqual([]);
  });

  it("returns empty results for non-object input", () => {
    expect(salvageSettingsPatch(null)).toEqual({ patch: {}, dropped: [] });
    expect(salvageSettingsPatch("garbage")).toEqual({ patch: {}, dropped: [] });
  });
});

describe("import backup", () => {
  beforeEach(() => fakeBrowser.reset());

  const now = new Date("2026-08-05T12:00:00.000Z");

  it("snapshots the pre-write settings and writes the computed ones", async () => {
    const before = SettingsSchema.parse({ speed: 2 });
    await setSettings(before);

    const next = await setSettingsWithBackup(
      (current) => SettingsSchema.parse({ ...current, pitch: 5 }),
      now,
    );
    expect(next.pitch).toBe(5);
    expect((await getSettings()).pitch).toBe(5);
    expect(await importBackupItem.getValue()).toEqual({
      savedAt: now.toISOString(),
      settings: before,
    });
  });

  it("works against the local area when sync is disabled", async () => {
    await setSyncEnabled(false);
    await setSettings(SettingsSchema.parse({ speed: 2 }));

    await setSettingsWithBackup(() => SettingsSchema.parse({ speed: 3 }), now);
    expect((await getSettings()).speed).toBe(3);
    expect((await importBackupItem.getValue())?.settings.speed).toBe(2);
  });

  it("restores the snapshot into the active area and clears the slot", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await setSettingsWithBackup(() => DEFAULT_SETTINGS, now);

    const restored = await restoreSettingsBackup();
    expect(restored?.speed).toBe(2);
    expect((await getSettings()).speed).toBe(2);
    expect(await importBackupItem.getValue()).toBeNull();
  });

  it("discard clears the slot without touching the settings", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await setSettingsWithBackup(() => SettingsSchema.parse({ speed: 3 }), now);

    await discardSettingsBackup();
    expect(await importBackupItem.getValue()).toBeNull();
    expect((await getSettings()).speed).toBe(3);
  });

  it("returns null and writes nothing when the slot is empty", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    expect(await restoreSettingsBackup()).toBeNull();
    expect((await getSettings()).speed).toBe(2);
  });

  it("keeps the previous snapshot when the computed settings do not validate", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await setSettingsWithBackup(() => SettingsSchema.parse({ speed: 3 }), now);
    const slotBefore = await importBackupItem.getValue();

    await expect(
      setSettingsWithBackup(() => ({ speed: "corrupt" }) as unknown as Settings, now),
    ).rejects.toThrow();
    expect(await importBackupItem.getValue()).toEqual(slotBefore);
    expect((await getSettings()).speed).toBe(3);
  });

  it("puts the previous snapshot back when the settings write itself rejects", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await setSettingsWithBackup(() => SettingsSchema.parse({ speed: 3 }), now);
    const slotBefore = await importBackupItem.getValue();

    // The settings object is in `sync` (default); the backup slot is in
    // `local`, so rejecting one sync write fails exactly the settings write
    // while the snapshot/rollback writes still succeed.
    const spy = vi
      .spyOn(fakeBrowser.storage.sync, "set")
      .mockRejectedValueOnce(new Error("QUOTA_BYTES_PER_ITEM quota exceeded"));
    try {
      await expect(
        setSettingsWithBackup(() => SettingsSchema.parse({ speed: 4 }), now),
      ).rejects.toThrow("QUOTA_BYTES_PER_ITEM");
    } finally {
      spy.mockRestore();
    }

    expect(await importBackupItem.getValue()).toEqual(slotBefore);
    expect((await getSettings()).speed).toBe(3);
  });

  it("clears a corrupt slot instead of restoring defaults over real settings", async () => {
    await setSettings(SettingsSchema.parse({ speed: 2 }));
    await importBackupItem.setValue({
      savedAt: now.toISOString(),
      settings: "garbage" as unknown as Settings,
    });

    expect(await restoreSettingsBackup()).toBeNull();
    expect(await importBackupItem.getValue()).toBeNull();
    expect((await getSettings()).speed).toBe(2);
  });
});

describe("write serialization", () => {
  beforeEach(() => fakeBrowser.reset());

  it("concurrent updates never clobber each other's fields", async () => {
    await setSettings(DEFAULT_SETTINGS);
    await Promise.all([
      updateSettings({ speed: 2 }),
      updateSettings({ pitch: 5 }),
      updateSettingsWith((c) => ({
        credentials: { ...c.credentials, polly: { accessKeyId: "a" } },
      })),
    ]);
    const settings = await getSettings();
    expect(settings.speed).toBe(2);
    expect(settings.pitch).toBe(5);
    expect(settings.credentials.polly?.accessKeyId).toBe("a");
  });
});

describe("sync toggle", () => {
  beforeEach(() => fakeBrowser.reset());

  it("moves settings between areas without a destructive gap", async () => {
    const custom = SettingsSchema.parse({ speed: 2.5 });
    await setSettings(custom); // lands in sync (default on)

    await setSyncEnabled(false);
    expect(await syncEnabledItem.getValue()).toBe(false);
    expect((await getSettings()).speed).toBe(2.5); // now read from local

    await setSyncEnabled(true);
    expect((await getSettings()).speed).toBe(2.5); // back in sync
  });
});
