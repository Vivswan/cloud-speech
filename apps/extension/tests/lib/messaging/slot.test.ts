import { describe, expect, it } from "vitest";
import { isAbortError, Slot, SlotAbortError, SlotMap } from "@/lib/messaging/slot";

describe("Slot", () => {
  it("hands each claimant a live signal and aborts the previous occupant as superseded", () => {
    const slot = new Slot();
    const first = slot.claim().signal;
    expect(first.aborted).toBe(false);

    const second = slot.claim().signal;
    expect(first.aborted).toBe(true);
    expect(first.reason).toBeInstanceOf(SlotAbortError);
    expect(first.reason).toMatchObject({ name: "AbortError", message: "superseded" });
    expect(second.aborted).toBe(false);
  });

  it("release aborts the occupant as released and frees the slot; a release of an empty slot is a no-op", () => {
    const slot = new Slot();
    expect(() => slot.release()).not.toThrow();

    const { signal } = slot.claim();
    slot.release();
    expect(signal.reason).toMatchObject({ name: "AbortError", message: "released" });

    const next = slot.claim().signal;
    expect(next.aborted).toBe(false);
    expect(() => next.throwIfAborted()).not.toThrow();
  });

  it("throwIfAborted on a superseded signal throws what isAbortError recognizes", () => {
    const slot = new Slot();
    const { signal } = slot.claim();
    slot.claim();
    let thrown: unknown;
    try {
      signal.throwIfAborted();
    } catch (error) {
      thrown = error;
    }
    expect(isAbortError(thrown)).toBe(true);
    expect(thrown).toBe(signal.reason);
  });
});

describe("SlotMap", () => {
  it("keeps keys independent and supersedes only within a key", () => {
    const slots = new SlotMap<"polly" | "azure">();
    const polly = slots.claim("polly").signal;
    const azure = slots.claim("azure").signal;

    const pollyAgain = slots.claim("polly").signal;
    expect(polly.reason).toMatchObject({ message: "superseded" });
    expect(azure.aborted).toBe(false);
    expect(pollyAgain.aborted).toBe(false);

    slots.release("azure");
    expect(azure.reason).toMatchObject({ message: "released" });
    expect(pollyAgain.aborted).toBe(false);

    slots.release("azure");
    expect(slots.claim("azure").signal.aborted).toBe(false);
  });
});

describe("isAbortError", () => {
  const cases: Array<{ label: string; error: unknown; expected: boolean }> = [
    { label: "a SlotAbortError", error: new SlotAbortError("superseded"), expected: true },
    {
      label: "the DOMException fetch rejects with",
      error: new DOMException("The operation was aborted.", "AbortError"),
      expected: true,
    },
    {
      label: "an SDK error object named AbortError",
      error: Object.assign(new Error("Request aborted"), { name: "AbortError" }),
      expected: true,
    },
    {
      label: "a timeout",
      error: new DOMException("The operation timed out.", "TimeoutError"),
      expected: false,
    },
    { label: "a plain Error", error: new Error("AbortError"), expected: false },
    { label: "a string", error: "AbortError", expected: false },
    { label: "null", error: null, expected: false },
  ];
  for (const { label, error, expected } of cases) {
    it(`is ${expected} for ${label}`, () => {
      expect(isAbortError(error)).toBe(expected);
    });
  }
});
