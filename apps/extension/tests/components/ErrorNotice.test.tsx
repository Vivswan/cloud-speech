import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { ErrorBanner, ErrorNotice } from "@/components/app/ErrorNotice";
import {
  clearBackgroundError,
  getBackgroundError,
  reportBackgroundError,
} from "@/lib/background-error";
import * as countdown from "@/lib/countdown";
import { ERROR_DISMISS_MS } from "@/lib/countdown";
import type { ErrorPayload } from "@/lib/protocol";

vi.mock("@/lib/countdown", { spy: true });

const NOTICE: ErrorPayload = {
  title: "Could not read aloud",
  message: "Your Google Cloud TTS key was rejected. Check it in Settings.",
  action: { label: "Fix it on the Google Cloud TTS website", url: "https://console.example/fix" },
  detail: "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403",
};

function advance(ms: number): void {
  act(() => {
    vi.advanceTimersByTime(ms);
  });
}

describe("ErrorNotice", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows title, message, and the action, with the technical detail collapsed", () => {
    render(<ErrorNotice error={NOTICE} onDismiss={() => {}} dismissAfterMs={1000} />);
    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(NOTICE.title);
    expect(notice).toHaveTextContent(NOTICE.message);
    expect(screen.getByRole("link", { name: NOTICE.action?.label })).toHaveAttribute(
      "href",
      NOTICE.action?.url,
    );
    const details = notice.querySelector("details");
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent(NOTICE.detail ?? "");
  });

  it("renders no action link when the payload has none; the Details are always there, collapsed", () => {
    render(
      <ErrorNotice
        error={{ title: "t", message: "m", detail: "Detail: d" }}
        onDismiss={() => {}}
        dismissAfterMs={1000}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    const details = screen.getByRole("alert").querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("Detail: d");
  });

  it("without onDismiss it is inline: no close button, and no countdown ever starts", () => {
    vi.mocked(countdown.startCountdown).mockClear();
    render(<ErrorNotice error={NOTICE} dismissAfterMs={1000} />);
    advance(ERROR_DISMISS_MS * 2);
    expect(screen.getByRole("alert")).toHaveTextContent(NOTICE.message);
    expect(screen.queryByTitle("common.dismiss")).toBeNull();
    expect(countdown.startCountdown).not.toHaveBeenCalled();
  });

  it("a new failure in the same inline notice starts with its Details collapsed again", () => {
    const { rerender } = render(<ErrorNotice error={NOTICE} />);
    const opened = screen.getByRole("alert").querySelector("details");
    if (!opened) throw new Error("the notice rendered no Details");
    opened.open = true;

    rerender(<ErrorNotice error={{ ...NOTICE, detail: "Error: MAX_WRITE_OPERATIONS" }} />);
    const details = screen.getByRole("alert").querySelector("details");
    expect(details).toHaveTextContent("Error: MAX_WRITE_OPERATIONS");
    expect(details?.open).toBe(false);
  });

  it("a new report with the same text (HTTP 403 twice) starts collapsed when keyed by report", () => {
    const { rerender } = render(<ErrorNotice error={NOTICE} reportKey={1} />);
    const opened = screen.getByRole("alert").querySelector("details");
    if (!opened) throw new Error("the notice rendered no Details");
    opened.open = true;

    // The same report re-rendered keeps what the user opened.
    rerender(<ErrorNotice error={{ ...NOTICE }} reportKey={1} />);
    expect(screen.getByRole("alert").querySelector("details")?.open).toBe(true);

    rerender(<ErrorNotice error={{ ...NOTICE }} reportKey={2} />);
    expect(screen.getByRole("alert").querySelector("details")?.open).toBe(false);
  });

  it("dismisses itself when the time is up", () => {
    const onDismiss = vi.fn();
    render(<ErrorNotice error={NOTICE} onDismiss={onDismiss} dismissAfterMs={1000} />);
    advance(999);
    expect(onDismiss).not.toHaveBeenCalled();
    advance(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("waits while the pointer is on it and continues from the time left", () => {
    const onDismiss = vi.fn();
    render(<ErrorNotice error={NOTICE} onDismiss={onDismiss} dismissAfterMs={1000} />);
    const notice = screen.getByRole("alert");
    advance(600);
    fireEvent.pointerEnter(notice);
    advance(10_000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.pointerLeave(notice);
    advance(399);
    expect(onDismiss).not.toHaveBeenCalled();
    advance(1);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("waits while keyboard focus is inside it, even after the pointer left", () => {
    const onDismiss = vi.fn();
    render(<ErrorNotice error={NOTICE} onDismiss={onDismiss} dismissAfterMs={1000} />);
    const notice = screen.getByRole("alert");
    const link = screen.getByRole("link");
    const close = screen.getByRole("button");

    fireEvent.pointerEnter(notice);
    fireEvent.focus(link);
    fireEvent.pointerLeave(notice);
    advance(10_000);
    expect(onDismiss).not.toHaveBeenCalled();

    // Focus moving within the notice keeps it held.
    fireEvent.blur(link, { relatedTarget: close });
    fireEvent.focus(close);
    advance(10_000);
    expect(onDismiss).not.toHaveBeenCalled();

    fireEvent.blur(close, { relatedTarget: document.body });
    advance(1000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it("dismisses at once from the close button, and never again from the clock", () => {
    const onDismiss = vi.fn();
    render(<ErrorNotice error={NOTICE} onDismiss={onDismiss} dismissAfterMs={1000} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    advance(10_000);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe("ErrorBanner", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    clearBackgroundError();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows nothing until a failure is reported, then that failure", () => {
    render(<ErrorBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
    act(() => reportBackgroundError(NOTICE));
    expect(screen.getByRole("alert")).toHaveTextContent(NOTICE.message);
  });

  it("gives a newer report a full countdown of its own, whatever the older one had left", () => {
    render(<ErrorBanner />);
    act(() => reportBackgroundError({ title: "first", message: "m", detail: "d" }));
    advance(ERROR_DISMISS_MS - 100);
    act(() => reportBackgroundError({ title: "second", message: "m", detail: "d" }));
    expect(screen.getByRole("alert")).toHaveTextContent("second");

    advance(ERROR_DISMISS_MS - 1);
    expect(screen.getByRole("alert")).toHaveTextContent("second");
    advance(1);
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getBackgroundError()).toBeNull();
  });

  it("clears the store from its close button", () => {
    render(<ErrorBanner />);
    act(() => reportBackgroundError(NOTICE));
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(getBackgroundError()).toBeNull();
  });
});
