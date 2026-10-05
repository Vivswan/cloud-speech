import { vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

export interface HeldRead {
  started: boolean;
  resolve(): void;
  reject(error: unknown): void;
  restore(): void;
}

/** Parks the next read of the synced settings until the test settles it, with the value the
 *  read would have returned, so a later change can overtake it. */
export function holdNextSyncRead(): HeldRead {
  const original = fakeBrowser.storage.sync.get.bind(fakeBrowser.storage.sync) as (
    key: string,
  ) => Promise<unknown>;
  let settled: { resolve: (value: unknown) => void; reject: (error: unknown) => void } | null =
    null;
  let stale: Promise<unknown> | null = null;
  const held: HeldRead = {
    started: false,
    resolve: () => {
      void stale?.then((value) => settled?.resolve(value));
    },
    reject: (error) => settled?.reject(error),
    restore: () => get.mockRestore(),
  };
  const get = vi.spyOn(fakeBrowser.storage.sync, "get").mockImplementation((key) => {
    if (held.started) return original(key as string);
    held.started = true;
    stale = original(key as string);
    return new Promise((resolve, reject) => {
      settled = { resolve, reject };
    });
  });
  return held;
}
