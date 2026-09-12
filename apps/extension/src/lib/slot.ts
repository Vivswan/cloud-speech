// A Slot has at most one occupant. Claiming hands the new occupant an
// AbortSignal and aborts the previous one, so "am I still the current
// preview/read/validation?" is answered by the signal (and the fetches it
// cancels) instead of by comparing generation counters after every await.

export type SlotAbortReason = "superseded" | "released";

/** Named "AbortError" so it is indistinguishable from a cancelled fetch to
 *  everything downstream. */
export class SlotAbortError extends Error {
  override readonly name = "AbortError";

  constructor(readonly reason: SlotAbortReason) {
    super(reason);
  }
}

export class Slot {
  private controller: AbortController | null = null;

  claim(): AbortSignal {
    this.controller?.abort(new SlotAbortError("superseded"));
    const controller = new AbortController();
    this.controller = controller;
    return controller.signal;
  }

  release(): void {
    this.controller?.abort(new SlotAbortError("released"));
    this.controller = null;
  }

  get occupied(): boolean {
    return this.controller !== null;
  }
}

export class SlotMap<K extends string> {
  private readonly slots = new Map<K, Slot>();

  claim(key: K): AbortSignal {
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

/** For work nothing can supersede (a user-triggered scan, a download). */
export const NEVER_ABORTS: AbortSignal = new AbortController().signal;
