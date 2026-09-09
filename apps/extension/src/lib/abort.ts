/**
 * A signal that aborts as soon as ANY of `signals` aborts, with that signal's
 * reason. Listeners are detached once the result aborts, so long-lived
 * inputs (a read slot) never accumulate them.
 */
export function anySignal(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();

  const alreadyAborted = signals.find((signal) => signal.aborted);
  if (alreadyAborted) {
    controller.abort(alreadyAborted.reason);
    return controller.signal;
  }

  const listeners = signals.map((signal) => {
    const listener = (): void => {
      controller.abort(signal.reason);
      detach();
    };
    signal.addEventListener("abort", listener);
    return [signal, listener] as const;
  });
  function detach(): void {
    for (const [signal, listener] of listeners) signal.removeEventListener("abort", listener);
  }

  return controller.signal;
}
