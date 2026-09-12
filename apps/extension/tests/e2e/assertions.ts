import { expect } from "@playwright/test";
import type { PopupObservations } from "./page-recorder";
import { historyReaches } from "./playback-waits";

// Assertions over the popup page's recorded observations, shared by the browser suites. Each takes a reader so one
// check serves whichever harness reads the page (Playwright on Chromium, Selenium on Firefox).

/** The transport's resume() publishes the parked position before commanding the host (src/lib/transport.ts), so for a
 *  mid-read pause the first recorded position is parkedAt and the ticks after it are the evidence. Both come from the page's own stamped history, so nothing depends on when the test process looks.
 *
 *  host restarted from 0                  -> a later tick below parkedAt
 *  element kept running through the pause -> a tick past the elapsed-time bound */
export async function resumeContinuesFrom(
  read: () => Promise<Pick<PopupObservations, "playbackHistory">>,
  parkedAt: number,
): Promise<void> {
  const history = await historyReaches(
    read,
    (entry) => entry.doc.status === "playing" && entry.doc.currentTime > parkedAt,
  );
  const playing = history.flatMap((entry) =>
    entry.doc.status === "playing" ? [{ at: entry.at, position: entry.doc.currentTime }] : [],
  );
  const [resumed, ...ticks] = playing;
  expect(resumed?.position).toBe(parkedAt);
  expect(ticks.length).toBeGreaterThan(0);
  for (const tick of ticks) {
    expect(tick.position).toBeGreaterThanOrEqual(parkedAt);
    expect(tick.position - parkedAt).toBeLessThanOrEqual((tick.at - resumed!.at) / 1000 + 0.25);
  }
}

/** `sentAt` is on the page clock, as the history entries are. */
export async function stopSettlesIdleWithinASecond(
  read: () => Promise<Pick<PopupObservations, "playbackHistory">>,
  sentAt: number,
): Promise<void> {
  const history = await historyReaches(
    read,
    (entry) => entry.doc.status === "idle" && entry.at >= sentAt,
  );
  const idle = history.find((entry) => entry.doc.status === "idle" && entry.at >= sentAt);
  expect((idle?.at ?? Number.POSITIVE_INFINITY) - sentAt).toBeLessThan(1000);
}

/** A preview that never sounded would clear the moment its replies went out, so the clear must trail the
 *  last server-stamped reply by at least `audioMs` (less clock slack). */
export async function previewStaysPressedFor(
  read: () => Promise<Pick<PopupObservations, "previewFlips">>,
  flipsBefore: number,
  repliesAt: number[],
  audioMs: number,
): Promise<void> {
  await expect
    .poll(async () => (await read()).previewFlips.slice(flipsBefore).length, {
      timeout: 15_000,
    })
    .toBe(2);
  const [pressed, cleared] = (await read()).previewFlips.slice(flipsBefore);
  expect(pressed?.pressed).toBe(true);
  expect(cleared?.pressed).toBe(false);
  expect((cleared?.at ?? 0) - Math.max(...repliesAt)).toBeGreaterThanOrEqual(audioMs - 250);
}
