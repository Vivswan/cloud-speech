import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { initRetiredMode } from "@/migrations/handoff/retired";
import { handoffBannerItem } from "@/migrations/handoff/state";

const LEGACY = "legacy-azure-id";

describe("retired mode on a fork install", () => {
  let removeAll: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    removeAll = vi.spyOn(fakeBrowser.contextMenus, "removeAll").mockResolvedValue(undefined);
  });

  it("removes the menus at start when the settings were already taken", async () => {
    fakeBrowser.runtime.id = LEGACY;
    await handoffBannerItem.setValue({ imported: true, dismissedAt: null });

    const mode = await initRetiredMode([LEGACY]);

    expect(mode.isRetired()).toBe(true);
    expect(removeAll).toHaveBeenCalledTimes(1);
  });

  it("retires live, once, when the import lands while the background is running", async () => {
    fakeBrowser.runtime.id = LEGACY;

    const mode = await initRetiredMode([LEGACY]);
    expect(mode.isRetired()).toBe(false);
    expect(removeAll).not.toHaveBeenCalled();

    await handoffBannerItem.setValue({ imported: true, dismissedAt: null });
    await vi.waitFor(() => expect(mode.isRetired()).toBe(true));
    // A later banner write (the user dismissing it) does not retire twice.
    await handoffBannerItem.setValue({ imported: true, dismissedAt: 1 });
    expect(removeAll).toHaveBeenCalledTimes(1);
  });

  it("stays inert on any other install, whatever the banner state says", async () => {
    fakeBrowser.runtime.id = "unified-extension-id";
    await handoffBannerItem.setValue({ imported: true, dismissedAt: null });

    const mode = await initRetiredMode([LEGACY]);
    await handoffBannerItem.setValue({ imported: true, dismissedAt: 2 });

    expect(mode.isRetired()).toBe(false);
    expect(removeAll).not.toHaveBeenCalled();
  });
});
