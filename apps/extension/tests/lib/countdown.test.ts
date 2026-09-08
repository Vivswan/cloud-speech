import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startCountdown } from "@/lib/countdown";

describe("startCountdown", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("fires once when the time is up", () => {
    const elapsed = vi.fn();
    startCountdown(1000, elapsed);
    vi.advanceTimersByTime(999);
    expect(elapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(elapsed).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5000);
    expect(elapsed).toHaveBeenCalledTimes(1);
  });

  it("waits while held and continues from the time left, not from the start", () => {
    const elapsed = vi.fn();
    const countdown = startCountdown(1000, elapsed);
    vi.advanceTimersByTime(600);
    countdown.hold("pointer");
    vi.advanceTimersByTime(10_000);
    expect(elapsed).not.toHaveBeenCalled();

    countdown.release("pointer");
    vi.advanceTimersByTime(399);
    expect(elapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(elapsed).toHaveBeenCalledTimes(1);
  });

  it("stays held until every reason is withdrawn", () => {
    const elapsed = vi.fn();
    const countdown = startCountdown(1000, elapsed);
    countdown.hold("pointer");
    countdown.hold("focus");
    countdown.release("pointer");
    vi.advanceTimersByTime(5000);
    expect(elapsed).not.toHaveBeenCalled();

    countdown.release("focus");
    vi.advanceTimersByTime(1000);
    expect(elapsed).toHaveBeenCalledTimes(1);
  });

  it("ignores a release of a reason never held: the deadline stays where it was", () => {
    const elapsed = vi.fn();
    const countdown = startCountdown(1000, elapsed);
    vi.advanceTimersByTime(300);
    countdown.release("never held");
    vi.advanceTimersByTime(699);
    expect(elapsed).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(elapsed).toHaveBeenCalledTimes(1);
    // A restarted clock would fire a second time 1000 ms after the release.
    vi.advanceTimersByTime(10_000);
    expect(elapsed).toHaveBeenCalledTimes(1);
  });

  it("ignores a repeated hold and a release after it fired", () => {
    const elapsed = vi.fn();
    const countdown = startCountdown(1000, elapsed);
    vi.advanceTimersByTime(500);
    countdown.hold("pointer");
    countdown.hold("pointer");
    vi.advanceTimersByTime(500);
    countdown.release("pointer");
    vi.advanceTimersByTime(500);
    expect(elapsed).toHaveBeenCalledTimes(1);

    countdown.release("pointer");
    vi.advanceTimersByTime(10_000);
    expect(elapsed).toHaveBeenCalledTimes(1);
  });

  it("never fires once cancelled, held or not", () => {
    const elapsed = vi.fn();
    const running = startCountdown(1000, elapsed);
    running.cancel();
    const held = startCountdown(1000, elapsed);
    held.hold("pointer");
    held.cancel();
    held.release("pointer");
    vi.advanceTimersByTime(10_000);
    expect(elapsed).not.toHaveBeenCalled();
  });
});
