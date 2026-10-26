// A Slot has at most one occupant. Claiming hands the new occupant a Claim
// and aborts the previous one, so "am I still the current
// preview/read/validation?" is answered by the claim's signal (and the fetches
// it cancels) instead of by comparing generation counters after every await.

export type SlotAbortReason = "superseded" | "released";

/** Named "AbortError" so it is indistinguishable from a cancelled fetch to
 *  everything downstream. */
export class SlotAbortError extends Error {
  override readonly name = "AbortError";

  constructor(readonly reason: SlotAbortReason) {
    super(reason);
  }
}

/** A claim on a Slot, as a value. Only `Slot.claim()` makes one (the class
 *  is not exported, and `#controller` keeps a look-alike object from passing
 *  for it), so a settings write, which takes a Claim
 *  (lib/settings/storage.ts), cannot be made without claiming a subject. */
class Claim {
  readonly #controller: AbortController;

  constructor(controller: AbortController) {
    this.#controller = controller;
  }

  get signal(): AbortSignal {
    return this.#controller.signal;
  }
}

export type { Claim };

export class Slot {
  private controller: AbortController | null = null;

  claim(): Claim {
    this.controller?.abort(new SlotAbortError("superseded"));
    const controller = new AbortController();
    this.controller = controller;
    return new Claim(controller);
  }

  release(): void {
    this.controller?.abort(new SlotAbortError("released"));
    this.controller = null;
  }
}

export class SlotMap<K extends string> {
  private readonly slots = new Map<K, Slot>();

  claim(key: K): Claim {
    let slot = this.slots.get(key);
    if (!slot) {
      slot = new Slot();
      this.slots.set(key, slot);
    }
    return slot.claim();
  }

  release(key: K): void {
    this.slots.get(key)?.release();
    this.slots.delete(key);
  }
}

/** True for a cancelled fetch (DOMException), an SDK abort, or a SlotAbortError. */
export function isAbortError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { name?: unknown }).name === "AbortError"
  );
}

/** For work nothing supersedes (a user-triggered scan, a download, a settings write under one lock grant). */
export const NEVER_SUPERSEDED: Claim = new Slot().claim();

/** NEVER_SUPERSEDED's signal, for a call that takes one but must run to its end. */
export const NEVER_ABORTS: AbortSignal = NEVER_SUPERSEDED.signal;
