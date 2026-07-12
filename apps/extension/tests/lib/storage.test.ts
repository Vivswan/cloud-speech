import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing";
import {
  DEFAULT_SETTINGS,
  getSettings,
  SettingsSchema,
  salvageSettings,
  setSettings,
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
