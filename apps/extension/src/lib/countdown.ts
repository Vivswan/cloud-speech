// Waits while someone is looking. Shared with the content-script toast, which
// is injected into every page, so no imports.

/** How long an error notice stays up when nobody is looking at it. */
export const ERROR_DISMISS_MS = 10_000;

export interface Countdown {
  /** Stop the clock for `reason` (a pointer over the notice, focus inside
   *  it), keeping the time left. Repeating a reason changes nothing. */
  hold(reason: string): void;
  /** Withdraw `reason`; the clock continues from the time left once no
   *  reason is left. Unknown reasons change nothing. */
  release(reason: string): void;
  cancel(): void;
}

export function startCountdown(ms: number, onElapsed: () => void): Countdown {
  const holds = new Set<string>();
  let remaining = ms;
  let startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined = setTimeout(elapse, ms);

  function elapse(): void {
    timer = undefined;
    remaining = 0;
    onElapsed();
  }

  return {
    hold(reason) {
      holds.add(reason);
      if (timer === undefined) return;
      clearTimeout(timer);
      timer = undefined;
      remaining = Math.max(0, remaining - (Date.now() - startedAt));
    },
    release(reason) {
      holds.delete(reason);
      if (holds.size > 0 || timer !== undefined || remaining <= 0) return;
      startedAt = Date.now();
      timer = setTimeout(elapse, remaining);
    },
    cancel() {
      clearTimeout(timer);
      timer = undefined;
      remaining = 0;
    },
  };
}
