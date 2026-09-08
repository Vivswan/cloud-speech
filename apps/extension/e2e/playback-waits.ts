import { expect } from "@playwright/test";
import type { Playback } from "../src/lib/playback";

// Waits over the playback document, shared by the browser suites. Each takes
// a reader so the same wait serves whichever harness reads the document
// (Playwright's service worker on Chromium, Selenium's popup page on Firefox).

export type PlaybackAt<S extends Playback["status"]> = Extract<Playback, { status: S }>;

/** One playback document as a popup page recorded it, stamped with the
 *  page's own Date.now(). */
export type PlaybackEntry = { at: number; doc: Playback };

/** Wait until the document reaches `status` (and `where`, when given) and
 *  return the document that did; a later re-read could already have moved on. */
export async function playbackReaches<S extends Playback["status"]>(
  read: () => Promise<Playback>,
  status: S,
  options: { where?: (doc: PlaybackAt<S>) => boolean; timeout?: number } = {},
): Promise<PlaybackAt<S>> {
  let matched: PlaybackAt<S> | undefined;
  await expect
    .poll(
      async () => {
        const doc = await read();
        if (doc.status === status) {
          const narrowed = doc as PlaybackAt<S>;
          if (options.where?.(narrowed) ?? true) matched = narrowed;
        }
        return matched !== undefined;
      },
      {
        message: `playback reaches ${status}`,
        timeout: options.timeout ?? 15_000,
        intervals: [100],
      },
    )
    .toBe(true);
  if (!matched) throw new Error(`playback never reached ${status}`);
  return matched;
}

/** A read that is audibly under way: playing, past position zero. */
export function playingWithSound(read: () => Promise<Playback>): Promise<PlaybackAt<"playing">> {
  return playbackReaches(read, "playing", { where: (doc) => doc.currentTime > 0 });
}

/** Wait until the page's recorded playback history holds an entry `where`
 *  accepts and return that history snapshot, so what is asserted is what was
 *  polled. */
export async function historyReaches(
  read: () => Promise<{ playbackHistory: PlaybackEntry[] }>,
  where: (entry: PlaybackEntry) => boolean,
): Promise<PlaybackEntry[]> {
  let snapshot: PlaybackEntry[] = [];
  await expect
    .poll(
      async () => {
        snapshot = (await read()).playbackHistory;
        return snapshot.some(where);
      },
      { message: "popup playback history reaches the expected entry", intervals: [100] },
    )
    .toBe(true);
  return snapshot;
}
