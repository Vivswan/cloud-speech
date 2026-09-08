import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { ErrorBanner, ErrorNotice } from "@/components/app/ErrorNotice";
import {
  clearBackgroundError,
  getBackgroundError,
  reportBackgroundError,
} from "@/lib/background-error";
import { ERROR_DISMISS_MS } from "@/lib/countdown";
import type { ErrorPayload } from "@/lib/protocol";

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

  it("renders no action link and no details when the payload has none", () => {
    render(
      <ErrorNotice
        error={{ title: "t", message: "m" }}
        onDismiss={() => {}}
        dismissAfterMs={1000}
      />,
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("alert").querySelector("details")).toBeNull();
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
    act(() => reportBackgroundError({ title: "first", message: "m" }));
    advance(ERROR_DISMISS_MS - 100);
    act(() => reportBackgroundError({ title: "second", message: "m" }));
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
