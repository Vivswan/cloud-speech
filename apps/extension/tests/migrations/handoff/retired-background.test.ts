import "./background-harness";
import { beforeAll, describe, expect, it, vi } from "vitest";
import background from "@/entrypoints/background";
import { surfaceError } from "@/lib/errors";
import { handoffBannerItem } from "@/migrations/handoff/state";
import {
  expectNoOpHandlers,
  listeners,
  localeChanged,
  menuIds,
  menus,
  wireForkBackground,
} from "./background-harness";

// The retired state reaching the menu rebuild, the menu clicks and the
// shortcut handler of a running background.

beforeAll(async () => {
  wireForkBackground();
  background.main();
  await vi.waitFor(() => expect(menuIds.size).toBe(5));
});

describe("background on a fork install whose settings get taken while it runs", () => {
  it("removes the menus, skips rebuilds and turns clicks and shortcuts into no-ops", async () => {
    // Control: before the import lands, the shortcut is live (no selection
    // in the fake browser, so it surfaces the "nothing selected" error).
    await listeners.onCommand("readAloudShortcut");
    expect(surfaceError).toHaveBeenCalledTimes(1);
    const removalsBefore = menus.removeAll.mock.calls.length;
    const menusBefore = menus.create.mock.calls.length;

    await handoffBannerItem.setValue({ dismissedAt: null, imported: true });
    await vi.waitFor(() => expect(menus.removeAll).toHaveBeenCalledTimes(removalsBefore + 1));
    expect(menuIds.size).toBe(0);

    localeChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(menus.create).toHaveBeenCalledTimes(menusBefore);
    expect(menuIds.size).toBe(0);

    await expectNoOpHandlers();
  });
});
