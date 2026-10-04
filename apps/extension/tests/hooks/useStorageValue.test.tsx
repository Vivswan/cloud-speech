import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { type StorageSource, useStorageValue } from "@/hooks/useStorageValue";

/** A storage item whose read captures the stored value when it starts but answers only on
 *  `answerRead`, so a write can land while the mount read is in flight, as it can in the
 *  extension when the background writes while a view mounts. */
function fakeItem<T>(stored: T) {
  const listeners = new Set<(value: T) => void>();
  const pending: Array<{ captured: T; resolve: (value: T) => void }> = [];
  const source: StorageSource<T> = {
    getValue: () =>
      new Promise<T>((resolve) => {
        pending.push({ captured: stored, resolve });
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
    get listenerCount() {
      return listeners.size;
    },
  };
}

const BEFORE_READ = Symbol("before read");

describe("useStorageValue", () => {
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
