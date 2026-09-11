import "./background-harness";
import { beforeAll, describe, expect, it, vi } from "vitest";
import background from "@/entrypoints/background";
import { handoffBannerItem } from "@/migrations/handoff/state";
import {
  expectNoOpHandlers,
  localeChanged,
  menuIds,
  menus,
  wireForkBackground,
} from "./background-harness";

// The unified install's exportSettings request cold-starts this worker, so
// its settingsImported can arrive while the first menu build still awaits
// its own removeAll(). The build's creates must not outlive the retirement.

let finishFirstRemoval = (): void => {};

beforeAll(async () => {
  menus.removeAll.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finishFirstRemoval = () => {
          menuIds.clear();
          resolve();
        };
      }),
  );
  wireForkBackground();
  background.main();
  await vi.waitFor(() => expect(menus.removeAll).toHaveBeenCalledTimes(1));
});

describe("background on a fork install whose settings get taken during its first menu build", () => {
  it("leaves no menus behind when the import lands while that removal is in flight", async () => {
    // The first build's removal was recorded in beforeAll, before the mock
    // history was cleared for this test.
    const removalsBefore = menus.removeAll.mock.calls.length;
    await handoffBannerItem.setValue({ dismissedAt: null, imported: true });
    // Lets the banner watch fire before the build's removal is released.
    await new Promise((resolve) => setTimeout(resolve, 20));
    finishFirstRemoval();

    // The retirement's own removal runs after the build, and the build
    // creates nothing.
    await vi.waitFor(() => expect(menus.removeAll).toHaveBeenCalledTimes(removalsBefore + 1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(menus.create).not.toHaveBeenCalled();
    expect(menuIds.size).toBe(0);

    localeChanged();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(menus.create).not.toHaveBeenCalled();
    expect(menuIds.size).toBe(0);

    await expectNoOpHandlers();
  });
});
