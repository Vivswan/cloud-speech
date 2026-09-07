import { describe, expect, it, vi } from "vitest";
import { anySignal } from "@/lib/abort";
import { SlotAbortError } from "@/lib/slot";

describe("anySignal", () => {
  it("stays live while every input is live, then aborts with the first aborter's reason", () => {
    const a = new AbortController();
    const b = new AbortController();
    const combined = anySignal([a.signal, b.signal]);
    expect(combined.aborted).toBe(false);

    const reason = new SlotAbortError("superseded");
    b.abort(reason);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe(reason);

    // A later abort of another input changes nothing.
    a.abort(new Error("late"));
    expect(combined.reason).toBe(reason);
  });

  it("returns an already-aborted signal synchronously when an input is already aborted", () => {
    const aborted = new AbortController();
    const reason = new DOMException("timed out", "TimeoutError");
    aborted.abort(reason);
    const live = new AbortController();

    const addLive = vi.spyOn(live.signal, "addEventListener");
    const combined = anySignal([live.signal, aborted.signal]);
    expect(combined.aborted).toBe(true);
    expect(combined.reason).toBe(reason);
    // Nothing was subscribed to the live input: no listener to leak.
    expect(addLive).not.toHaveBeenCalled();
  });

  it("detaches exactly the listeners it registered from every input once it aborts", () => {
    const a = new AbortController();
    const b = new AbortController();
    const spies = [a, b].map((controller) => ({
      add: vi.spyOn(controller.signal, "addEventListener"),
      remove: vi.spyOn(controller.signal, "removeEventListener"),
    }));

    const combined = anySignal([a.signal, b.signal]);
    a.abort(new SlotAbortError("released"));

    expect(combined.reason).toMatchObject({ message: "released" });
    for (const { add, remove } of spies) {
      expect(add).toHaveBeenCalledTimes(1);
      const registered = add.mock.calls[0]?.[1];
      expect(remove).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith("abort", registered);
    }
  });
});
