import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

const idb = vi.hoisted(() => ({
  entries: new Map<IDBValidKey, unknown>(),
  setError: null as Error | null,
}));

vi.mock("idb-keyval", () => ({
  createStore: () => "store",
  get: async (key: IDBValidKey) => idb.entries.get(key),
  set: async (key: IDBValidKey, value: unknown) => {
    if (idb.setError) throw idb.setError;
    idb.entries.set(key, value);
  },
  del: async (key: IDBValidKey) => {
    idb.entries.delete(key);
  },
}));

import {
  applyAudioEvent,
  claimPlayback,
  IDLE_PLAYBACK,
  type Playback,
  type PlaybackDraft,
  PlaybackSchema,
  patchPlaybackRate,
  playbackAudio,
  readPlayback,
  updatePlayback,
  watchPlayback,
} from "@/lib/playback";
import { withLock } from "@/lib/storage";

async function storedRaw(): Promise<unknown> {
  const stored = await fakeBrowser.storage.session.get("playback");
  return stored.playback;
}

const PLAYING: Playback = {
  status: "playing",
  epoch: 1,
  rate: 1,
  textDigest: "abc:12",
  currentTime: 4,
  duration: 30,
};

async function seed(doc: Playback): Promise<void> {
  await fakeBrowser.storage.session.set({ playback: doc });
}

beforeEach(() => {
  fakeBrowser.reset();
  idb.entries.clear();
  idb.setError = null;
});

describe("claimPlayback", () => {
  it("bumps the epoch by exactly one and persists the whole document", async () => {
    const first = await claimPlayback(() => ({
      status: "synthesizing",
      rate: 1,
      textDigest: "abc:12",
    }));
    const expectedFirst: Playback = {
      status: "synthesizing",
      epoch: 1,
      rate: 1,
      textDigest: "abc:12",
    };
    expect(first).toEqual(expectedFirst);
    expect(await storedRaw()).toEqual(expectedFirst);

    const second = await claimPlayback((current) => ({ status: "idle", rate: current.rate }));
    const expectedSecond: Playback = { status: "idle", epoch: 2, rate: 1 };
    expect(second).toEqual(expectedSecond);
    expect(await readPlayback()).toEqual(expectedSecond);
  });

  it("writes nothing and resolves null when the claim declines", async () => {
    await seed(PLAYING);
    const result = await claimPlayback(() => null);
    expect(result).toBeNull();
    expect(await storedRaw()).toEqual(PLAYING);
  });

  it("gives overlapping claims consecutive epochs in call order", async () => {
    const draft = (textDigest: string): PlaybackDraft => ({
      status: "synthesizing",
      rate: 1,
      textDigest,
    });
    const [first, second] = await Promise.all([
      claimPlayback(() => draft("first")),
      claimPlayback(() => draft("second")),
    ]);
    expect(first).toEqual({ status: "synthesizing", epoch: 1, rate: 1, textDigest: "first" });
    expect(second).toEqual({ status: "synthesizing", epoch: 2, rate: 1, textDigest: "second" });
    expect(await storedRaw()).toEqual(second);
    expect(await updatePlayback(1, () => draft("loser"))).toBeNull();
  });
});

describe("updatePlayback", () => {
  it("applies the change while the epoch matches", async () => {
    await seed(PLAYING);
    const result = await updatePlayback(1, (current) => ({ ...current, currentTime: 9 }));
    const expected: Playback = { ...PLAYING, currentTime: 9 };
    expect(result).toEqual(expected);
    expect(await storedRaw()).toEqual(expected);
  });

  it("resolves null, writes nothing, and never calls fn on a stale epoch", async () => {
    await seed(PLAYING);
    const fn = vi.fn(() => ({ status: "idle", rate: 1 }) as const);
    expect(await updatePlayback(0, fn)).toBeNull();
    expect(fn).not.toHaveBeenCalled();
    expect(await storedRaw()).toEqual(PLAYING);
  });
});

describe("patchPlaybackRate", () => {
  it.each<Playback>([
    IDLE_PLAYBACK,
    { status: "synthesizing", epoch: 3, rate: 1, textDigest: "abc:12" },
    PLAYING,
    { ...PLAYING, status: "paused", epoch: 7 },
  ])("keeps status and epoch of $status", async (doc) => {
    await seed(doc);
    const result = await patchPlaybackRate(1.5);
    expect(result).toEqual({ ...doc, rate: 1.5 });
    expect(await storedRaw()).toEqual({ ...doc, rate: 1.5 });
  });
});

describe("applyAudioEvent", () => {
  it("copies the position of a progress event while playing", async () => {
    await seed(PLAYING);
    const result = await applyAudioEvent({
      kind: "progress",
      epoch: 1,
      currentTime: 12.5,
      duration: 31,
    });
    const expected: Playback = { ...PLAYING, currentTime: 12.5, duration: 31 };
    expect(result).toEqual(expected);
    expect(await storedRaw()).toEqual(expected);
  });

  it("parks an ended read as paused at the final position", async () => {
    await seed(PLAYING);
    const result = await applyAudioEvent({
      kind: "ended",
      epoch: 1,
      currentTime: 30,
      duration: 30,
    });
    const expected: Playback = {
      status: "paused",
      epoch: 1,
      rate: 1,
      textDigest: "abc:12",
      currentTime: 30,
      duration: 30,
    };
    expect(result).toEqual(expected);
    expect(await storedRaw()).toEqual(expected);
  });

  it.each<Playback>([
    { ...PLAYING, status: "paused" },
    { status: "synthesizing", epoch: 1, rate: 1, textDigest: "abc:12" },
    { status: "idle", epoch: 1, rate: 1 },
  ])("leaves a $status document untouched by a late progress tick", async (doc) => {
    await seed(doc);
    const result = await applyAudioEvent({
      kind: "progress",
      epoch: 1,
      currentTime: 29,
      duration: 30,
    });
    expect(result).toEqual(doc);
    expect(await storedRaw()).toEqual(doc);
  });

  it("drops an event from a superseded epoch", async () => {
    await seed({ ...PLAYING, epoch: 2 });
    const result = await applyAudioEvent({
      kind: "ended",
      epoch: 1,
      currentTime: 30,
      duration: 30,
    });
    expect(result).toBeNull();
    expect(await storedRaw()).toEqual({ ...PLAYING, epoch: 2 });
  });
});

describe("readPlayback and watchPlayback", () => {
  it.each<unknown>([
    "garbage",
    { status: "playing", epoch: -1, rate: 1, textDigest: "x", currentTime: 0, duration: 0 },
    { status: "playing", epoch: 1, rate: 1 },
    { status: "idle", epoch: 1, rate: 0 },
  ])("reads a corrupt stored value %j as idle", async (raw) => {
    await fakeBrowser.storage.session.set({ playback: raw });
    expect(await readPlayback()).toEqual(IDLE_PLAYBACK);
  });

  it("delivers parsed documents to watchers until unwatched", async () => {
    const seen: Playback[] = [];
    const unwatch = watchPlayback((doc) => seen.push(doc));

    await claimPlayback(() => ({ status: "synthesizing", rate: 1, textDigest: "abc:12" }));
    await fakeBrowser.storage.session.set({ playback: "garbage" });
    unwatch();
    await claimPlayback(() => ({ status: "idle", rate: 1 }));

    expect(seen).toEqual([
      { status: "synthesizing", epoch: 1, rate: 1, textDigest: "abc:12" },
      IDLE_PLAYBACK,
    ]);
  });
});

describe("playbackAudio", () => {
  const record = { epoch: 3, synthesisKey: "key", audioUri: "data:audio/ogg;base64,AAAA" };

  it("round-trips a record and clears it", async () => {
    await playbackAudio.set(record);
    expect(await playbackAudio.get()).toEqual(record);
    await playbackAudio.clear();
    expect(await playbackAudio.get()).toBeNull();
  });

  it("swallows a failed write, logs once, and reads back null", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    idb.setError = new DOMException("quota", "QuotaExceededError");
    await expect(playbackAudio.set(record)).resolves.toBeUndefined();
    await expect(playbackAudio.set(record)).resolves.toBeUndefined();
    expect(await playbackAudio.get()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
});

describe("withLock", () => {
  it("serializes operations on one name and not across names", async () => {
    const order: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const a = withLock("lock-a", async () => {
      order.push("a:start");
      await gate;
      order.push("a:end");
    });
    const b = withLock("lock-a", async () => {
      order.push("b:start");
    });
    const c = withLock("lock-b", async () => {
      order.push("c:start");
    });

    await c;
    expect(order).toEqual(["a:start", "c:start"]);
    release();
    await Promise.all([a, b]);
    expect(order).toEqual(["a:start", "c:start", "a:end", "b:start"]);
  });
});

describe("document invariants", () => {
  const rate = fc.double({ min: 0.25, max: 4, noNaN: true });
  const position = fc.double({ min: 0, max: 7200, noNaN: true });
  const textDigest = fc.string({ maxLength: 8 });
  const epoch = fc.nat({ max: 6 });

  const draft: fc.Arbitrary<PlaybackDraft> = fc.oneof(
    fc.record({ status: fc.constant("idle" as const), rate }),
    fc.record({ status: fc.constant("synthesizing" as const), rate, textDigest }),
    fc.record({
      status: fc.constant("playing" as const),
      rate,
      textDigest,
      currentTime: position,
      duration: position,
    }),
    fc.record({
      status: fc.constant("paused" as const),
      rate,
      textDigest,
      currentTime: position,
      duration: position,
    }),
  );

  const operation = fc.oneof(
    fc.record({ op: fc.constant("claim" as const), draft }),
    fc.record({ op: fc.constant("update" as const), epoch, draft }),
    fc.record({
      op: fc.constant("event" as const),
      event: fc.record({
        kind: fc.constantFrom("progress" as const, "ended" as const),
        epoch,
        currentTime: position,
        duration: position,
      }),
    }),
    fc.record({ op: fc.constant("rate" as const), rate }),
  );

  it("always stores a document that strict-parses with a non-decreasing epoch", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(operation, { maxLength: 25 }), async (operations) => {
        fakeBrowser.reset();
        let lastEpoch = 0;
        for (const step of operations) {
          if (step.op === "claim") await claimPlayback(() => step.draft);
          else if (step.op === "update") await updatePlayback(step.epoch, () => step.draft);
          else if (step.op === "event") await applyAudioEvent(step.event);
          else await patchPlaybackRate(step.rate);

          const raw = (await storedRaw()) ?? IDLE_PLAYBACK;
          const parsed = PlaybackSchema.safeParse(raw);
          expect(parsed.success).toBe(true);
          if (!parsed.success) return;
          expect(parsed.data).toEqual(raw);
          expect(parsed.data.epoch).toBeGreaterThanOrEqual(lastEpoch);
          lastEpoch = parsed.data.epoch;
        }
      }),
      { numRuns: 150 },
    );
  });
});
