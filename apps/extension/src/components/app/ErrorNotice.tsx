import { X } from "lucide-react";
import { useEffect, useRef } from "react";
import { useBackgroundError } from "@/hooks/useBackgroundError";
import { cn } from "@/lib/cn";
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

/** An action the notice offers in place of the payload's link: a button that
 *  runs in the popup (retry, open Settings). Handlers cannot cross the wire,
 *  so this exists only on the component, never on ErrorPayload. */
export interface NoticeAction {
  label: string;
  onClick: () => void;
}

/** How the notice is read out and painted. A failure interrupts (role
 *  alert, danger palette); a note is a state the user should know about with
 *  nothing failed (settings owned by a newer build, a download still
 *  running), announced politely (role status) in the note palette. */
export type NoticeTone = "failure" | "note";

export interface ErrorNoticeProps {
  error: ErrorPayload;
  /** The identity of the report `error` came from (hooks/useReport.ts):
   *  every new report starts with its Details collapsed, a second failure
   *  with the same text (HTTP 403 twice) included. Absent, the Details
   *  follow the text: right for a notice that shows a state (a voice's
   *  stored issue) rather than a report. */
  reportKey?: number | string;
  /** Given: the notice has a close button and dismisses itself after
   *  `dismissAfterMs`. Absent: an inline notice that stays until its owner
   *  stops rendering it (a Save & test result, a Sandbox failure). */
  onDismiss?: () => void;
  dismissAfterMs?: number;
  /** Replaces `error.action`. */
  action?: NoticeAction;
  tone?: NoticeTone;
  className?: string;
}

/** Everything below the title: the one-sentence message, the one action on
 *  its own line (a button when `action` is given, else the payload's link),
 *  and the raw technical text behind a collapsed Details in a monospace
 *  block. Surfaces with a heading of their own (a voice row) render this
 *  alone. */
export function ErrorNoticeBody({
  error,
  reportKey,
  action,
}: {
  error: Pick<ErrorPayload, "message" | "action" | "detail">;
  reportKey?: number | string;
  action?: NoticeAction;
}) {
  return (
    <>
      <p className="break-words leading-snug">{error.message}</p>
      {action ? (
        <button
          type="button"
          className="inline-block cursor-pointer font-semibold underline underline-offset-2"
          onClick={action.onClick}
        >
          {action.label}
        </button>
      ) : (
        error.action && (
          <a
            href={error.action.url}
            target="_blank"
            rel="noreferrer"
            className="inline-block font-semibold underline underline-offset-2"
          >
            {error.action.label}
          </a>
        )
      )}
      {error.detail && (
        // Keyed by the report, else by the text: a new failure replacing this
        // one in the same mounted notice starts with its Details collapsed.
        <details key={reportKey ?? error.detail} className="pt-0.5">
          <summary className="cursor-pointer select-none opacity-80">
            {i18n.t("errors.details")}
          </summary>
          <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all font-mono text-xxs opacity-80">
            {error.detail}
          </pre>
        </details>
      )}
    </>
  );
}

/** A failure in plain words: bold title on its own line, one sentence
 *  below, the one action on its own line, and the raw technical text behind
 *  a collapsed Details in a monospace block. With `onDismiss`, dismisses
 *  itself after `dismissAfterMs` unless the pointer or the keyboard focus is
 *  on it; the countdown then waits and continues from where it stopped. The
 *  countdown runs for the component's lifetime, so the parent keys the
 *  component by the error it shows: a new error mounts a fresh notice with a
 *  full one. */
export function ErrorNotice({
  error,
  reportKey,
  onDismiss,
  dismissAfterMs = ERROR_DISMISS_MS,
  action,
  tone = "failure",
  className,
}: ErrorNoticeProps) {
  const countdown = useRef<Countdown | null>(null);

  useEffect(() => {
    if (!onDismiss) return;
    const timer = startCountdown(dismissAfterMs, onDismiss);
    countdown.current = timer;
    return () => {
      timer.cancel();
      if (countdown.current === timer) countdown.current = null;
    };
  }, [dismissAfterMs, onDismiss]);

  const classes = cn(
    "px-3 py-2 text-xs",
    tone === "note"
      ? "border-note-edge bg-note text-note-text"
      : "border-danger-edge bg-danger-surface text-danger",
    onDismiss ? "border-b" : "rounded-md border",
    className,
  );
  const body = (
    <div className="flex items-start gap-2">
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-semibold leading-snug">{error.title}</p>
        <ErrorNoticeBody error={error} reportKey={reportKey} action={action} />
      </div>
      {onDismiss && (
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
      )}
    </div>
  );

  // A note is read politely and never counts down, so it needs none of the
  // hold-and-release handlers a dismissing alert carries.
  if (tone === "note") {
    return (
      <div role="status" className={classes}>
        {body}
      </div>
    );
  }
  return (
    <div
      role="alert"
      className={classes}
      onPointerEnter={() => countdown.current?.hold("pointer")}
      onPointerLeave={() => countdown.current?.release("pointer")}
      onFocus={() => countdown.current?.hold("focus")}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          countdown.current?.release("focus");
        }
      }}
    >
      {body}
    </div>
  );
}
