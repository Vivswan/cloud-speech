import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { initRetiredMode } from "@/migrations/handoff/retired";
import { handoffBannerItem } from "@/migrations/handoff/state";

const LEGACY = "legacy-azure-id";

describe("retired mode on a fork install", () => {
  let clearMenus: ReturnType<typeof vi.fn<() => Promise<void>>>;

  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    clearMenus = vi.fn(async () => {});
  });

  it("removes the menus at start when the settings were already taken", async () => {
    fakeBrowser.runtime.id = LEGACY;
    await handoffBannerItem.setValue({ dismissedAt: null, imported: true });

    const mode = await initRetiredMode(clearMenus, [LEGACY]);

    expect(mode.isRetired()).toBe(true);
    expect(clearMenus).toHaveBeenCalledTimes(1);
  });

  it("retires live, once, when the import lands while the background is running", async () => {
    fakeBrowser.runtime.id = LEGACY;

    const mode = await initRetiredMode(clearMenus, [LEGACY]);
    expect(mode.isRetired()).toBe(false);
    expect(clearMenus).not.toHaveBeenCalled();

    await handoffBannerItem.setValue({ dismissedAt: null, imported: true });
    await vi.waitFor(() => expect(mode.isRetired()).toBe(true));
    // A later banner write (the user dismissing it) does not retire twice.
    await handoffBannerItem.setValue({ dismissedAt: 1, imported: true });
    expect(clearMenus).toHaveBeenCalledTimes(1);
  });

  it("stays inert on any other install, whatever the banner state says", async () => {
    fakeBrowser.runtime.id = "unified-extension-id";
    await handoffBannerItem.setValue({ dismissedAt: null, imported: true });

    const mode = await initRetiredMode(clearMenus, [LEGACY]);
    await handoffBannerItem.setValue({ dismissedAt: 2, imported: true });

    expect(mode.isRetired()).toBe(false);
    expect(clearMenus).not.toHaveBeenCalled();
  });
});
