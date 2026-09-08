import { expect } from "@playwright/test";
import type { PopupObservations } from "./page-recorder";
import { historyReaches } from "./playback-waits";

// Assertions over the popup page's recorded observations, shared by the
// browser suites. Each takes a reader so the same check serves whichever
// harness reads the page (Playwright on Chromium, Selenium on Firefox).

/** The positions the element reports after a resume are the evidence, read
 *  from the page's own stamped record of every document written. The resume
 *  itself writes the parked position; every later tick may exceed it by at
 *  most the page time elapsed since that write. A resume from 0 writes
 *  smaller positions; an element that kept running through the pause writes
 *  one past the bound. Nothing here depends on when the test process looks. */
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

/** A stop sent at `sentAt` (page clock) lands an idle document within a
 *  second, as the page's history recorded it. */
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

/** After a preview whose replies the server stamped at `repliesAt`, the row
 *  flips exactly twice past `flipsBefore`: pressed, then cleared no earlier
 *  than `audioMs` (less clock slack) after the last reply went out. A preview
 *  that never sounded would clear the moment its replies went out. */
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
