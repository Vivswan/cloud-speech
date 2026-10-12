import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type StorageSource, useStorageValue } from "@/hooks/useStorageValue";

/** A storage item whose read captures the stored value when it starts but answers only on
 *  `answerRead` (or fails on `failRead`), so a write can land while the mount read is in flight,
 *  as it can in the extension when the background writes while a view mounts. */
function fakeItem<T>(stored: T) {
  const listeners = new Set<(value: T) => void>();
  const pending: Array<{
    captured: T;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
  }> = [];
  const source: StorageSource<T> = {
    getValue: () =>
      new Promise<T>((resolve, reject) => {
        pending.push({ captured: stored, resolve, reject });
      }),
    watch(callback) {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    },
  };
  return {
    source,
    write(value: T) {
      stored = value;
      for (const listener of listeners) listener(value);
    },
    answerRead() {
      for (const read of pending.splice(0)) read.resolve(read.captured);
    },
    failRead(error: unknown) {
      for (const read of pending.splice(0)) read.reject(error);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

const BEFORE_READ = Symbol("before read");
const READ_ERROR = new Error("Access to storage is not allowed from this context");

describe("useStorageValue", () => {
  afterEach(() => vi.restoreAllMocks());

  it("a rejected first read is reported as a warning, stays at beforeRead, and a later change still delivers", async () => {
    const item = fakeItem<string | null>("stored");
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { result } = renderHook(() => useStorageValue(item.source, BEFORE_READ));

    await act(async () => item.failRead(READ_ERROR));
    expect(result.current).toBe(BEFORE_READ);
    expect(warned.mock.calls).toEqual([[`Reading a storage item failed: ${String(READ_ERROR)}`]]);

    act(() => item.write("later"));
    expect(result.current).toBe("later");
  });

  it.each([{ madeObsoleteBy: "a watched change" }, { madeObsoleteBy: "an unmount" }])(
    "a first read that fails after $madeObsoleteBy reports nothing: its answer was obsolete",
    async ({ madeObsoleteBy }) => {
      const item = fakeItem<string | null>("stored");
      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      const { result, unmount } = renderHook(() => useStorageValue(item.source, BEFORE_READ));
      if (madeObsoleteBy === "an unmount") unmount();
      else act(() => item.write("delivered"));

      await act(async () => item.failRead(READ_ERROR));

      expect(warned).not.toHaveBeenCalled();
      expect(result.current).toBe(madeObsoleteBy === "an unmount" ? BEFORE_READ : "delivered");
    },
  );

  it.each([{ change: "written" }, { change: null }])(
    "a change ($change) that arrives before the initial read answers is not overwritten by it",
    async ({ change }) => {
      const item = fakeItem<string | null>("stored");
      const { result, unmount } = renderHook(() => useStorageValue(item.source, BEFORE_READ));
      expect(result.current).toBe(BEFORE_READ);

      act(() => item.write(change));
      expect(result.current).toBe(change);

      await act(async () => item.answerRead());
      expect(result.current).toBe(change);

      unmount();
      expect(item.listenerCount).toBe(0);
    },
  );
});
