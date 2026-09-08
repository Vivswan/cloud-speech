import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useBackgroundError } from "@/hooks/useBackgroundError";
import { type Countdown, ERROR_DISMISS_MS, startCountdown } from "@/lib/countdown";
import { i18n } from "@/lib/i18n-runtime";
import type { ErrorPayload } from "@/lib/protocol";

/** Global error strip: background failures (synthesis, previews) land here so
 *  no error is ever silent, whatever view is open. */
export function ErrorBanner() {
  const { error, sequence, clearError } = useBackgroundError();
  if (!error) return null;
  // Keyed per report: a new failure gets a fresh notice and a full countdown.
  return <ErrorNotice key={sequence} error={error} onDismiss={clearError} />;
}

/** A failure in plain words: title, message, the one action, and the raw
 *  technical text behind a collapsed Details. Dismisses itself after
 *  `dismissAfterMs` unless the pointer or the keyboard focus is on it; the
 *  countdown then waits and continues from where it stopped. The countdown
 *  runs for the component's lifetime, so the parent keys the component by
 *  the error it shows: a new error mounts a fresh notice with a full one. */
export function ErrorNotice({
  error,
  onDismiss,
  dismissAfterMs = ERROR_DISMISS_MS,
}: {
  error: ErrorPayload;
  onDismiss: () => void;
  dismissAfterMs?: number;
}) {
  const countdown = useRef<Countdown | null>(null);

  useEffect(() => {
    const timer = startCountdown(dismissAfterMs, onDismiss);
    countdown.current = timer;
    return () => {
      timer.cancel();
      if (countdown.current === timer) countdown.current = null;
    };
  }, [dismissAfterMs, onDismiss]);

  return (
    <div
      role="alert"
      className="border-b border-danger-edge bg-danger-surface px-3 py-2 text-xs text-danger"
      onPointerEnter={() => countdown.current?.hold("pointer")}
      onPointerLeave={() => countdown.current?.release("pointer")}
      onFocus={() => countdown.current?.hold("focus")}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          countdown.current?.release("focus");
        }
      }}
    >
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="font-semibold">{error.title}</p>
          <p className="break-words">{error.message}</p>
          {error.action && (
            <a
              href={error.action.url}
              target="_blank"
              rel="noreferrer"
              className="inline-block font-semibold underline underline-offset-2"
            >
              {error.action.label}
            </a>
          )}
          {error.detail && (
            <details className="pt-0.5">
              <summary className="cursor-pointer select-none text-danger/80">
                {i18n.t("errors.details")}
              </summary>
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xxs text-danger/80">
                {error.detail}
              </pre>
            </details>
          )}
        </div>
        <button
          type="button"
          title={i18n.t("common.dismiss")}
          className="shrink-0 cursor-pointer rounded p-0.5 text-danger/70 hover:bg-danger-edge/40 hover:text-danger"
          onClick={() => {
            countdown.current?.cancel();
            onDismiss();
          }}
        >
          <X size={13} />
        </button>
      </div>
    </div>
  );
}
