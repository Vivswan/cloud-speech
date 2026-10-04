import { describe, expect, it } from "vitest";
import { isAbortError, NEVER_ABORTS, Slot, SlotAbortError, SlotMap } from "@/lib/slot";

describe("Slot", () => {
  it("hands each claimant a live signal and aborts the previous occupant as superseded", () => {
    const slot = new Slot();
    const first = slot.claim();
    expect(first.aborted).toBe(false);

    const second = slot.claim();
    expect(first.aborted).toBe(true);
    expect(first.reason).toBeInstanceOf(SlotAbortError);
    expect(first.reason).toMatchObject({ name: "AbortError", message: "superseded" });
    expect(second.aborted).toBe(false);
  });

  it("release aborts the occupant as released and frees the slot; a release of an empty slot is a no-op", () => {
    const slot = new Slot();
    expect(() => slot.release()).not.toThrow();

    const signal = slot.claim();
    slot.release();
    expect(signal.reason).toMatchObject({ name: "AbortError", message: "released" });

    // A fresh claim after release is unaffected by the released signal.
    const next = slot.claim();
    expect(next.aborted).toBe(false);
    expect(() => next.throwIfAborted()).not.toThrow();
  });

  it("throwIfAborted on a superseded signal throws what isAbortError recognizes", () => {
    const slot = new Slot();
    const signal = slot.claim();
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
    const polly = slots.claim("polly");
    const azure = slots.claim("azure");

    const pollyAgain = slots.claim("polly");
    expect(polly.reason).toMatchObject({ message: "superseded" });
    expect(azure.aborted).toBe(false);
    expect(pollyAgain.aborted).toBe(false);

    slots.release("azure");
    expect(azure.reason).toMatchObject({ message: "released" });
    expect(pollyAgain.aborted).toBe(false);

    // Releasing a key nobody holds is a no-op, and the key can be reclaimed.
    slots.release("azure");
    expect(slots.claim("azure").aborted).toBe(false);
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

describe("NEVER_ABORTS", () => {
  it("is a live signal with no way to abort it", () => {
    expect(NEVER_ABORTS.aborted).toBe(false);
    expect(() => NEVER_ABORTS.throwIfAborted()).not.toThrow();
  });
});
