import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// Mock the modules transport depends on BEFORE importing it.
vi.mock("@/lib/synthesize", () => ({
  getAudioUri: vi.fn().mockResolvedValue("data:audio/ogg;base64,AAAA"),
}));
vi.mock("@/lib/audio-host", () => ({
  ensureAudioHost: vi.fn().mockResolvedValue(undefined),
  sendToAudioHost: vi.fn(),
}));
vi.mock("@/lib/errors", () => ({ surfaceError: vi.fn(async () => {}) }));
vi.mock("@/lib/i18n-runtime", () => ({ i18n: { t: (key: string) => key } }));

const idb = vi.hoisted(() => ({
  entries: new Map<IDBValidKey, unknown>(),
  /** When set, reads wait for it: a record lookup that outlasts other work. */
  gate: null as Promise<void> | null,
}));
vi.mock("idb-keyval", () => ({
  createStore: () => "store",
  get: async (key: IDBValidKey) => {
    await idb.gate;
    return idb.entries.get(key);
  },
  set: async (key: IDBValidKey, value: unknown) => {
    idb.entries.set(key, value);
  },
  del: async (key: IDBValidKey) => {
    idb.entries.delete(key);
  },
}));

import { ensureAudioHost, sendToAudioHost } from "@/lib/audio-host";
import { textDigest } from "@/lib/digest";
import { surfaceError } from "@/lib/errors";
import {
  applyAudioEvent,
  IDLE_PLAYBACK,
  type Playback,
  playbackAudio,
  readPlayback,
} from "@/lib/playback";
import { DEFAULT_SETTINGS, updateSettings, voiceIssuesItem, withLock } from "@/lib/storage";
import { getAudioUri } from "@/lib/synthesize";
import * as transport from "@/lib/transport";

const AUDIO = "data:audio/ogg;base64,AAAA";

/** Default audio-host responses: a position for the commands the real
 *  session answers with one, a plain ack for everything else. */
function stubAudioHost(position: { currentTime: number; duration: number }): void {
  vi.mocked(sendToAudioHost).mockImplementation(async (id) =>
    id === "seekTo" || id === "pause" ? position : "ok",
  );
}

function hostCalls(id: string): unknown[] {
  return vi
    .mocked(sendToAudioHost)
    .mock.calls.filter(([calledId]) => calledId === id)
    .map(([, payload]) => payload);
}

async function untilStatus(status: Playback["status"]): Promise<Playback> {
  await vi.waitFor(async () => {
    expect((await readPlayback()).status).toBe(status);
  });
  return readPlayback();
}

function seed(doc: Playback): Promise<void> {
  return fakeBrowser.storage.session.set({ playback: doc });
}

/** A provider request that, like fetch, only settles when its signal aborts. */
function pendingSynthesis(): void {
  vi.mocked(getAudioUri).mockImplementationOnce(
    ({ signal }) =>
      new Promise<string>((_, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason));
      }),
  );
}

describe("transport", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    idb.entries.clear();
    idb.gate = null;
    vi.clearAllMocks();
    vi.mocked(getAudioUri).mockResolvedValue(AUDIO);
    vi.mocked(ensureAudioHost).mockResolvedValue(undefined);
    stubAudioHost({ currentTime: 0, duration: 0 });
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await transport.stopReading();
    await seed(IDLE_PLAYBACK);
  });

  it("starts idle", async () => {
    expect(await readPlayback()).toEqual(IDLE_PLAYBACK);
  });

  it("synthesizes the whole text once, records it, and plays one merged file under the claimed epoch", async () => {
    await expect(transport.startReading("First sentence. Second sentence.")).resolves.toBe(true);

    const playing = await untilStatus("playing");
    expect(playing).toEqual({
      status: "playing",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("First sentence. Second sentence."),
      currentTime: 0,
      duration: 0,
    });
    expect(getAudioUri).toHaveBeenCalledTimes(1);
    expect(hostCalls("play")).toEqual([{ audioUri: AUDIO, rate: 1, epoch: 1, startAt: 0 }]);
    expect(await playbackAudio.get()).toMatchObject({ epoch: 1, audioUri: AUDIO });

    // The session's ended event parks the read at its final position.
    await applyAudioEvent({ kind: "ended", epoch: 1, currentTime: 12, duration: 12 });
    expect(await readPlayback()).toEqual({
      ...playing,
      status: "paused",
      currentTime: 12,
      duration: 12,
    });
  });

  it("a second read while the first synthesizes cancels the first and plays exactly once", async () => {
    pendingSynthesis();
    await transport.startReading("First read.");
    await vi.waitFor(() => expect(getAudioUri).toHaveBeenCalledTimes(1));
    const first = vi.mocked(getAudioUri).mock.calls[0]?.[0].signal;
    expect(first?.aborted).toBe(false);

    await transport.startReading("Second read.");
    expect(first?.reason).toMatchObject({ name: "AbortError", message: "superseded" });
    expect(await untilStatus("playing")).toEqual({
      status: "playing",
      epoch: 2,
      rate: 1,
      textDigest: textDigest("Second read."),
      currentTime: 0,
      duration: 0,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hostCalls("play")).toEqual([{ audioUri: AUDIO, rate: 1, epoch: 2, startAt: 0 }]);
    // The cancelled read reached neither the user nor the console.
    expect(surfaceError).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
  });

  it("stop mid-synthesis cancels the read and settles idle silently", async () => {
    pendingSynthesis();
    await transport.startReading("Stop me early.");
    await vi.waitFor(() => expect(getAudioUri).toHaveBeenCalledTimes(1));
    const signal = vi.mocked(getAudioUri).mock.calls[0]?.[0].signal;
    expect(await readPlayback()).toMatchObject({ status: "synthesizing", epoch: 1 });

    await transport.stopReading();
    expect(signal?.reason).toMatchObject({ name: "AbortError", message: "released" });
    expect(await readPlayback()).toEqual({ status: "idle", epoch: 2, rate: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(surfaceError).not.toHaveBeenCalled();
    expect(console.error).not.toHaveBeenCalled();
    expect(hostCalls("play")).toEqual([]);
  });

  it("a read stopped before its claim landed leaves no synthesis keepalive behind", async () => {
    vi.useFakeTimers();
    try {
      const pings = vi.spyOn(fakeBrowser.runtime, "getPlatformInfo").mockResolvedValue(undefined);
      await Promise.all([transport.startReading("Race text."), transport.stopReading()]);
      await vi.advanceTimersByTimeAsync(41_000);
      expect(await readPlayback()).toEqual({ status: "idle", epoch: 2, rate: 1 });
      expect(pings).not.toHaveBeenCalled();

      // Control: a read still synthesizing does ping, until it is stopped.
      pendingSynthesis();
      await transport.startReading("Slow text.");
      await vi.advanceTimersByTimeAsync(41_000);
      expect(pings).toHaveBeenCalledTimes(2);
      await transport.stopReading();
      await vi.advanceTimersByTimeAsync(41_000);
      expect(pings).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stopReading settles idle, keeps the rate, and tells the host to stop", async () => {
    await transport.setRate(1.5);
    await transport.startReading("One. Two. Three.");
    await untilStatus("playing");
    vi.mocked(sendToAudioHost).mockClear();

    await transport.stopReading();

    expect(await readPlayback()).toEqual({ status: "idle", epoch: 2, rate: 1.5 });
    expect(hostCalls("stop")).toHaveLength(1);
  });

  it("setRate writes the document's rate and forwards it to the session", async () => {
    await expect(transport.setRate(1.5)).resolves.toBe(true);
    expect(await readPlayback()).toEqual({ ...IDLE_PLAYBACK, rate: 1.5 });
    expect(hostCalls("setRate")).toEqual([{ rate: 1.5 }]);
  });

  it("keeps the chosen rate across reads instead of resetting to 1", async () => {
    await transport.setRate(1.5);
    await transport.startReading("Another read.");
    expect(await untilStatus("playing")).toEqual({
      status: "playing",
      epoch: 1,
      rate: 1.5,
      textDigest: textDigest("Another read."),
      currentTime: 0,
      duration: 0,
    });
    expect(hostCalls("play")).toEqual([{ audioUri: AUDIO, rate: 1.5, epoch: 1, startAt: 0 }]);

    // A speed passed by the caller (the 2x context menu entry) wins.
    await transport.startReading("Faster.", 2);
    await vi.waitFor(async () => {
      expect(await readPlayback()).toEqual({
        status: "playing",
        epoch: 2,
        rate: 2,
        textDigest: textDigest("Faster."),
        currentTime: 0,
        duration: 0,
      });
    });
    expect(hostCalls("play").at(-1)).toEqual({ audioUri: AUDIO, rate: 2, epoch: 2, startAt: 0 });
  });

  it("reuses the recorded audio for an identical read and re-keys it to the new epoch", async () => {
    await transport.startReading("Cache me.");
    await untilStatus("playing");
    const first = await playbackAudio.get();
    expect(first).toEqual({ epoch: 1, synthesisKey: expect.any(String), audioUri: AUDIO });

    await transport.startReading("Cache me.");
    await vi.waitFor(async () => {
      expect(await readPlayback()).toEqual({
        status: "playing",
        epoch: 2,
        rate: 1,
        textDigest: textDigest("Cache me."),
        currentTime: 0,
        duration: 0,
      });
    });
    expect(getAudioUri).toHaveBeenCalledTimes(1);
    expect(await playbackAudio.get()).toEqual({ ...first, epoch: 2 });
    expect(hostCalls("play")).toEqual([
      { audioUri: AUDIO, rate: 1, epoch: 1, startAt: 0 },
      { audioUri: AUDIO, rate: 1, epoch: 2, startAt: 0 },
    ]);

    // Different text is a different synthesis.
    await transport.startReading("Cache me not.");
    await vi.waitFor(async () => {
      expect(await readPlayback()).toEqual({
        status: "playing",
        epoch: 3,
        rate: 1,
        textDigest: textDigest("Cache me not."),
        currentTime: 0,
        duration: 0,
      });
    });
    expect(getAudioUri).toHaveBeenCalledTimes(2);
    const third = await playbackAudio.get();
    expect(third).toEqual({ epoch: 3, synthesisKey: expect.any(String), audioUri: AUDIO });
    expect(third?.synthesisKey).not.toBe(first?.synthesisKey);
  });

  it("pause and seek are no-ops unless audio is loaded", async () => {
    await expect(transport.pause()).resolves.toBe(false);
    await expect(transport.seekTo(5)).resolves.toBe(false);
    expect(await readPlayback()).toEqual(IDLE_PLAYBACK);
    expect(hostCalls("pause")).toEqual([]);
    expect(hostCalls("seekTo")).toEqual([]);
  });

  it("a stop landing during start's setup wins (last request, not last resume)", async () => {
    const started = transport.startReading("Race text.");
    const stopped = transport.stopReading();
    await Promise.all([started, stopped]);
    // Give any stale detached synthesis a chance to (incorrectly) play.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readPlayback()).toEqual({ status: "idle", epoch: 2, rate: 1 });
    expect(hostCalls("play")).toEqual([]);
    expect(surfaceError).not.toHaveBeenCalled();
  });

  it("a position event stamped for a stopped or older read never lands", async () => {
    await transport.startReading("Stop me.");
    await untilStatus("playing");
    await transport.stopReading();
    const idle: Playback = { status: "idle", epoch: 2, rate: 1 };

    // The stopped read's stamp is stale; the post-stop epoch has no timeline.
    expect(
      await applyAudioEvent({ kind: "progress", epoch: 1, currentTime: 42, duration: 60 }),
    ).toBeNull();
    expect(
      await applyAudioEvent({ kind: "progress", epoch: 2, currentTime: 42, duration: 60 }),
    ).toEqual(idle);
    expect(await readPlayback()).toEqual(idle);

    await transport.startReading("Read B.");
    const b = await untilStatus("playing");
    expect(b.epoch).toBe(3);
    expect(
      await applyAudioEvent({ kind: "progress", epoch: 1, currentTime: 42, duration: 60 }),
    ).toBeNull();
    expect(await readPlayback()).toEqual(b);
    expect(
      await applyAudioEvent({ kind: "progress", epoch: 3, currentTime: 42, duration: 60 }),
    ).toEqual({
      ...b,
      currentTime: 42,
      duration: 60,
    });
  });

  it("an ended event from a read a newer one superseded is dropped", async () => {
    await transport.startReading("Read A.");
    await untilStatus("playing");
    await transport.startReading("Read B.");
    await vi.waitFor(async () => {
      expect(await readPlayback()).toMatchObject({ status: "playing", epoch: 2 });
    });

    expect(
      await applyAudioEvent({ kind: "ended", epoch: 1, currentTime: 99, duration: 100 }),
    ).toBeNull();
    expect(await readPlayback()).toEqual({
      status: "playing",
      epoch: 2,
      rate: 1,
      textDigest: textDigest("Read B."),
      currentTime: 0,
      duration: 0,
    });
  });

  it("records the session's committed seek position, not a re-clamp of its own", async () => {
    await transport.startReading("Seek me.");
    await untilStatus("playing");
    // The document knows no duration yet; the session, which sees the real
    // element, commits the seek at face value.
    stubAudioHost({ currentTime: 5, duration: 60 });

    await expect(transport.seekTo(5)).resolves.toBe(true);
    expect(await readPlayback()).toEqual({
      status: "playing",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Seek me."),
      currentTime: 5,
      duration: 60,
    });
    expect(hostCalls("seekTo")).toEqual([{ seconds: 5 }]);
  });

  it("a seek the session took while still loading keeps the document's duration", async () => {
    await transport.startReading("Loading.");
    await untilStatus("playing");
    await applyAudioEvent({ kind: "progress", epoch: 1, currentTime: 30, duration: 90 });
    stubAudioHost({ currentTime: 50, duration: 0 });

    await expect(transport.seekTo(50)).resolves.toBe(true);
    expect(await readPlayback()).toEqual({
      status: "playing",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Loading."),
      currentTime: 50,
      duration: 90,
    });
  });

  it("a seek while parked with the session gone moves the parked position for the replay", async () => {
    await transport.startReading("Park me.");
    await untilStatus("playing");
    await applyAudioEvent({ kind: "progress", epoch: 1, currentTime: 10, duration: 60 });
    stubAudioHost({ currentTime: 10, duration: 60 });
    await transport.pause();
    vi.mocked(sendToAudioHost).mockRejectedValue(new Error("No seekable audio loaded"));

    await expect(transport.seekTo(90)).resolves.toBe(true);
    expect(await readPlayback()).toEqual({
      status: "paused",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Park me."),
      currentTime: 60,
      duration: 60,
    });
  });

  it("a seek committed between resume's read and its write is what the resume keeps", async () => {
    await transport.startReading("Seek then resume.");
    await untilStatus("playing");
    await applyAudioEvent({ kind: "progress", epoch: 1, currentTime: 30, duration: 90 });
    stubAudioHost({ currentTime: 30, duration: 90 });
    await transport.pause();
    vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
      if (id === "resume") throw new Error("Nothing loaded to resume");
      if (id === "play") return new Promise<string>(() => {});
      return "ok";
    });
    vi.mocked(sendToAudioHost).mockClear();

    // The seek holds the playback lock while resume reads the (older) document
    // and queues behind it.
    let resumed: Promise<boolean> = Promise.resolve(false);
    await withLock("cloud-speech-playback", async () => {
      resumed = transport.resume();
      await new Promise((resolve) => setTimeout(resolve, 10));
      await fakeBrowser.storage.session.set({
        playback: {
          status: "paused",
          epoch: 1,
          rate: 1,
          textDigest: textDigest("Seek then resume."),
          currentTime: 50,
          duration: 90,
        },
      });
    });
    await expect(resumed).resolves.toBe(true);

    await vi.waitFor(() => {
      expect(hostCalls("play")).toEqual([{ audioUri: AUDIO, rate: 1, epoch: 1, startAt: 50 }]);
    });
    expect(await readPlayback()).toEqual({
      status: "playing",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Seek then resume."),
      currentTime: 50,
      duration: 90,
    });
  });

  it("a severed play's rejection queued behind a resume's update leaves the resumed read alone", async () => {
    let sever: (error: Error) => void = () => {};
    vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
      if (id === "play")
        return new Promise<string>((_, reject) => {
          sever = reject;
        });
      if (id === "pause") return { currentTime: 12, duration: 60 };
      return "ok";
    });
    await transport.startReading("Sever behind resume.");
    await untilStatus("playing");
    await transport.pause();
    vi.mocked(sendToAudioHost).mockClear();

    // The resume's locked update is queued first; the rejection's settle
    // queues behind it while the document still says paused.
    let resumed: Promise<boolean> = Promise.resolve(false);
    await withLock("cloud-speech-playback", async () => {
      resumed = transport.resume();
      await new Promise((resolve) => setTimeout(resolve, 10));
      sever(new Error("The message port closed before a response was received."));
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await expect(resumed).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readPlayback()).toEqual({
      status: "playing",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Sever behind resume."),
      currentTime: 12,
      duration: 60,
    });
    expect(hostCalls("resume")).toEqual([{ epoch: 1 }]);
    expect(surfaceError).not.toHaveBeenCalled();
  });

  it("a resume's recovery that a pause and a second resume overtook decides nothing", async () => {
    await transport.startReading("Resume twice.");
    await untilStatus("playing");
    stubAudioHost({ currentTime: 12, duration: 60 });
    await transport.pause();
    // The first resume's play() is interrupted by the pause that follows it,
    // so its host call rejects; its record lookup is slow.
    vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
      if (id === "resume")
        throw new Error("The play() request was interrupted by a call to pause()");
      if (id === "pause") return { currentTime: 12, duration: 60 };
      return "ok";
    });
    vi.mocked(sendToAudioHost).mockClear();
    let releaseLookup: () => void = () => {};
    idb.gate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    idb.entries.clear();
    const first = transport.resume();
    await new Promise((resolve) => setTimeout(resolve, 10));

    await expect(transport.pause()).resolves.toBe(true);
    stubAudioHost({ currentTime: 12, duration: 60 });
    await expect(transport.resume()).resolves.toBe(true);
    const playing = await readPlayback();
    expect(playing).toEqual({
      status: "playing",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Resume twice."),
      currentTime: 12,
      duration: 60,
    });

    releaseLookup();
    await expect(first).resolves.toBe(false);
    expect(await readPlayback()).toEqual(playing);
    expect(surfaceError).not.toHaveBeenCalled();
    expect(hostCalls("play")).toEqual([]);
  });

  it("a resume's replay queued behind a newer resume's update does not reload the audio", async () => {
    await transport.startReading("Resume, pause, resume.");
    await untilStatus("playing");
    stubAudioHost({ currentTime: 12, duration: 60 });
    await transport.pause();
    vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
      if (id === "resume")
        throw new Error("The play() request was interrupted by a call to pause()");
      if (id === "pause") return { currentTime: 12, duration: 60 };
      return "ok";
    });
    vi.mocked(sendToAudioHost).mockClear();
    let releaseLookup: () => void = () => {};
    idb.gate = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const first = transport.resume();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await expect(transport.pause()).resolves.toBe(true);
    vi.mocked(sendToAudioHost).mockImplementation(async (id) =>
      id === "pause" ? { currentTime: 12, duration: 60 } : "ok",
    );

    // The second resume has read the document and queued its locked update;
    // the first resume's lookup completes before that update is granted, so
    // its ownership check still passes and its replay queues behind.
    let second: Promise<boolean> = Promise.resolve(false);
    await withLock("cloud-speech-playback", async () => {
      second = transport.resume();
      await new Promise((resolve) => setTimeout(resolve, 10));
      releaseLookup();
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    await expect(second).resolves.toBe(true);
    await expect(first).resolves.toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(hostCalls("resume")).toEqual([{ epoch: 1 }, { epoch: 1 }]);
    expect(hostCalls("play")).toEqual([]);
    expect(await readPlayback()).toEqual({
      status: "playing",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Resume, pause, resume."),
      currentTime: 12,
      duration: 60,
    });
    expect(surfaceError).not.toHaveBeenCalled();
  });

  it("a seek overlapping a recycled resume lands in the replay's start position", async () => {
    await transport.startReading("Seek and resume.");
    await untilStatus("playing");
    await applyAudioEvent({ kind: "progress", epoch: 1, currentTime: 30, duration: 90 });
    stubAudioHost({ currentTime: 30, duration: 90 });
    await transport.pause();
    vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
      if (id === "seekTo") throw new Error("No seekable audio loaded");
      if (id === "resume") throw new Error("Nothing loaded to resume");
      if (id === "play") return new Promise<string>(() => {});
      return "ok";
    });
    vi.mocked(sendToAudioHost).mockClear();

    const [sought, resumed] = await Promise.all([transport.seekTo(50), transport.resume()]);
    expect([sought, resumed]).toEqual([true, true]);

    await vi.waitFor(() => {
      expect(hostCalls("play")).toEqual([{ audioUri: AUDIO, rate: 1, epoch: 1, startAt: 50 }]);
    });
    expect(await readPlayback()).toEqual({
      status: "playing",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Seek and resume."),
      currentTime: 50,
      duration: 90,
    });
  });

  it.each([
    {
      host: "answers with the element's position",
      answer: { currentTime: 12.5, duration: 60 },
      parkedAt: 12.5,
    },
    { host: "is gone (nothing answers)", answer: null, parkedAt: 10 },
  ])("pause parks at the session's position when the host $host", async ({ answer, parkedAt }) => {
    await transport.startReading("Pause me.");
    await untilStatus("playing");
    // The throttled tick trails the element; it is what remains without a host.
    await applyAudioEvent({ kind: "progress", epoch: 1, currentTime: 10, duration: 60 });
    if (answer) stubAudioHost(answer);
    else vi.mocked(sendToAudioHost).mockRejectedValue(new Error("audio did not respond to pause"));

    await expect(transport.pause()).resolves.toBe(true);
    expect(await readPlayback()).toEqual({
      status: "paused",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Pause me."),
      currentTime: parkedAt,
      duration: 60,
    });
  });

  it("pause turns the document before it tells the host, then refines the position", async () => {
    await transport.startReading("Order me.");
    await untilStatus("playing");
    await applyAudioEvent({ kind: "progress", epoch: 1, currentTime: 10, duration: 60 });
    const statusWhenHostPaused: string[] = [];
    vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
      if (id !== "pause") return "ok";
      statusWhenHostPaused.push((await readPlayback()).status);
      return { currentTime: 10.4, duration: 60 };
    });

    await expect(transport.pause()).resolves.toBe(true);

    expect(statusWhenHostPaused).toEqual(["paused"]);
    expect(await readPlayback()).toEqual({
      status: "paused",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Order me."),
      currentTime: 10.4,
      duration: 60,
    });
  });

  it.each([
    { path: "a fresh read's play", setup: async () => {} },
    {
      path: "a resume that found nothing loaded",
      setup: async () => {
        await untilStatus("playing");
        stubAudioHost({ currentTime: 30, duration: 60 });
        await transport.pause();
        vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
          if (id === "resume") throw new Error("Nothing loaded to resume");
          return "ok";
        });
      },
    },
  ])("a pause landing while the host is still being created wins over $path", async ({ setup }) => {
    await transport.startReading("Host is slow.");
    await setup();
    let hostUp: () => void = () => {};
    vi.mocked(ensureAudioHost).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          hostUp = resolve;
        }),
    );
    const before = await readPlayback();
    const resumed = before.status === "paused" ? transport.resume() : null;
    await vi.waitFor(async () => {
      expect(vi.mocked(ensureAudioHost).mock.calls.length).toBeGreaterThan(0);
    });
    const playing = await untilStatus("playing");
    vi.mocked(sendToAudioHost).mockClear();
    vi.mocked(sendToAudioHost).mockRejectedValue(new Error("audio did not respond to pause"));

    // No host yet, so the pause reaches nothing; the document still parks.
    await expect(transport.pause()).resolves.toBe(true);
    hostUp();
    if (resumed) await expect(resumed).resolves.toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readPlayback()).toEqual({ ...playing, status: "paused" });
    expect(hostCalls("play")).toEqual([]);
    expect(hostCalls("resume")).toEqual([]);
    expect(surfaceError).not.toHaveBeenCalled();
  });

  it("a rate chosen while the host is being created reaches the play command", async () => {
    await transport.startReading("Rate me.");
    let hostUp: () => void = () => {};
    vi.mocked(ensureAudioHost).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          hostUp = resolve;
        }),
    );
    await untilStatus("playing");
    await vi.waitFor(() => {
      expect(vi.mocked(ensureAudioHost).mock.calls.length).toBeGreaterThan(1);
    });
    await expect(transport.setRate(2)).resolves.toBe(true);
    hostUp();

    await vi.waitFor(() => {
      expect(hostCalls("play")).toEqual([{ audioUri: AUDIO, rate: 2, epoch: 1, startAt: 0 }]);
    });
    expect(await readPlayback()).toEqual({
      status: "playing",
      epoch: 1,
      rate: 2,
      textDigest: textDigest("Rate me."),
      currentTime: 0,
      duration: 0,
    });
  });

  it("resume continues in the session when it still holds the audio", async () => {
    await transport.startReading("Resume me.");
    await untilStatus("playing");
    stubAudioHost({ currentTime: 8, duration: 60 });
    await transport.pause();
    vi.mocked(sendToAudioHost).mockClear();

    await expect(transport.resume()).resolves.toBe(true);
    expect(await readPlayback()).toEqual({
      status: "playing",
      epoch: 1,
      rate: 1,
      textDigest: textDigest("Resume me."),
      currentTime: 8,
      duration: 60,
    });
    expect(hostCalls("resume")).toEqual([{ epoch: 1 }]);
    expect(hostCalls("play")).toEqual([]);
  });

  it.each([
    { parked: "mid-way", position: { currentTime: 30, duration: 60 }, startAt: 30 },
    { parked: "at its end", position: { currentTime: 60, duration: 60 }, startAt: 0 },
  ])(
    "resume replays the recorded audio of a read parked $parked when the session lost it",
    async ({ position, startAt }) => {
      await transport.startReading("Recycle me.");
      await untilStatus("playing");
      await applyAudioEvent({ kind: "ended", epoch: 1, ...position });
      // Chrome closed the idle offscreen document: a fresh one has nothing
      // loaded, and the replay's play command settles only when the audio ends.
      vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
        if (id === "resume") throw new Error("Nothing loaded to resume");
        if (id === "play") return new Promise<string>(() => {});
        return "ok";
      });
      vi.mocked(sendToAudioHost).mockClear();

      // Resolves at once: the replay runs detached (its play command settles
      // only when the audio ends).
      await expect(transport.resume()).resolves.toBe(true);
      await vi.waitFor(async () => {
        expect(await readPlayback()).toEqual({
          status: "playing",
          epoch: 1,
          rate: 1,
          textDigest: textDigest("Recycle me."),
          currentTime: startAt,
          duration: 60,
        });
      });
      await vi.waitFor(() => {
        expect(hostCalls("play")).toEqual([{ audioUri: AUDIO, rate: 1, epoch: 1, startAt }]);
      });
      expect(getAudioUri).toHaveBeenCalledTimes(1);
      expect(surfaceError).not.toHaveBeenCalled();
    },
  );

  it("a play severed while the read was parked is ignored once a resume took over", async () => {
    let sever: (error: Error) => void = () => {};
    vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
      if (id === "play")
        return new Promise<string>((_, reject) => {
          sever = reject;
        });
      if (id === "pause") return { currentTime: 3, duration: 30 };
      return "ok";
    });
    await transport.startReading("Pause, resume, sever.");
    await untilStatus("playing");
    await transport.pause();
    await expect(transport.resume()).resolves.toBe(true);
    const resumed = await readPlayback();
    expect(resumed).toMatchObject({ status: "playing", epoch: 1, currentTime: 3 });

    sever(new Error("The message port closed before a response was received."));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readPlayback()).toEqual(resumed);
    expect(surfaceError).not.toHaveBeenCalled();
  });

  it.each([
    { record: null, name: "no record" },
    {
      record: { epoch: 1, synthesisKey: "older", audioUri: AUDIO },
      name: "an older read's record",
    },
  ])(
    "resume with $name reports the loss and settles idle at the same epoch",
    async ({ record }) => {
      await transport.startReading("Lost.");
      await untilStatus("playing");
      await transport.startReading("Lost again.");
      await vi.waitFor(async () => {
        expect(await readPlayback()).toMatchObject({ status: "playing", epoch: 2 });
      });
      stubAudioHost({ currentTime: 5, duration: 60 });
      await transport.pause();
      if (record) await playbackAudio.set(record);
      else await playbackAudio.clear();
      vi.mocked(sendToAudioHost).mockRejectedValue(new Error("Nothing loaded to resume"));

      await expect(transport.resume()).resolves.toBe(false);
      expect(await readPlayback()).toEqual({ status: "idle", epoch: 2, rate: 1 });
      expect(surfaceError).toHaveBeenCalledExactlyOnceWith(new Error("errors.audio_unavailable"));
      expect(hostCalls("play")).toHaveLength(2);
    },
  );

  it("a read paused in one background context resumes where it was in a fresh one", async () => {
    await transport.setRate(1.5);
    await transport.startReading("Parked read.");
    await untilStatus("playing");
    await applyAudioEvent({ kind: "progress", epoch: 1, currentTime: 32, duration: 90 });
    stubAudioHost({ currentTime: 33, duration: 90 });
    await transport.pause();
    const parked: Playback = {
      status: "paused",
      epoch: 1,
      rate: 1.5,
      textDigest: textDigest("Parked read."),
      currentTime: 33,
      duration: 90,
    };
    expect(await readPlayback()).toEqual(parked);

    // The worker was recycled (and the popup reopened): a fresh module finds
    // the same document, and the host has nothing loaded.
    vi.resetModules();
    const host = await import("@/lib/audio-host");
    vi.mocked(host.ensureAudioHost).mockResolvedValue(undefined);
    vi.mocked(host.sendToAudioHost).mockImplementation(async (id) => {
      if (id === "resume") throw new Error("Nothing loaded to resume");
      return "ok";
    });
    const fresh = await import("@/lib/transport");
    expect(await readPlayback()).toEqual(parked);

    await expect(fresh.resume()).resolves.toBe(true);
    await vi.waitFor(() => {
      expect(vi.mocked(host.sendToAudioHost)).toHaveBeenCalledWith("play", {
        audioUri: AUDIO,
        rate: 1.5,
        epoch: 1,
        startAt: 33,
      });
    });
    expect(await readPlayback()).toEqual({ ...parked, status: "playing" });
  });

  const RECORD = { epoch: 7, synthesisKey: "k", audioUri: AUDIO };
  it.each<{ left: string; doc: Playback; after: Playback; record: typeof RECORD | null }>([
    {
      left: "a synthesizing document (settles idle, record kept)",
      doc: { status: "synthesizing", epoch: 4, rate: 1, textDigest: "x" },
      after: { status: "idle", epoch: 4, rate: 1 },
      record: RECORD,
    },
    {
      left: "a paused document (kept, record kept)",
      doc: { status: "paused", epoch: 2, rate: 1, textDigest: "x", currentTime: 1, duration: 2 },
      after: { status: "paused", epoch: 2, rate: 1, textDigest: "x", currentTime: 1, duration: 2 },
      record: RECORD,
    },
    {
      left: "nothing of this browser session (record of a previous one dropped)",
      doc: IDLE_PLAYBACK,
      after: IDLE_PLAYBACK,
      record: null,
    },
  ])("recoverPlayback finds $left", async ({ doc, after, record }) => {
    await seed(doc);
    await playbackAudio.set(RECORD);

    await transport.recoverPlayback();

    expect(await readPlayback()).toEqual(after);
    expect(await playbackAudio.get()).toEqual(record);
  });

  it("a failed synthesis marks the voice, settles idle, and is surfaced exactly once", async () => {
    await updateSettings({ selectedVoice: { providerId: "polly", voiceId: "Joanna" } });
    vi.mocked(getAudioUri).mockRejectedValueOnce(new Error("Provider says no"));

    await transport.startReading("Fail me.");
    await untilStatus("idle");

    expect(await readPlayback()).toEqual({ status: "idle", epoch: 1, rate: 1 });
    expect(surfaceError).toHaveBeenCalledExactlyOnceWith(new Error("Provider says no"));
    expect(await voiceIssuesItem.getValue()).toEqual({
      [`polly:Joanna:${DEFAULT_SETTINGS.model}`]: "Error: Provider says no",
    });
    expect(hostCalls("play")).toEqual([]);
  });

  it.each([
    {
      state: "still sounding",
      pauseFirst: false,
      after: { status: "idle", epoch: 1, rate: 1 } as Playback,
      surfaced: [new Error("The message port closed before a response was received.")],
    },
    {
      state: "parked by a pause",
      pauseFirst: true,
      after: {
        status: "paused",
        epoch: 1,
        rate: 1,
        textDigest: textDigest("Sever me."),
        currentTime: 3,
        duration: 30,
      } as Playback,
      surfaced: [],
    },
  ])("a play rejected while the read is $state", async ({ pauseFirst, after, surfaced }) => {
    let sever: (error: Error) => void = () => {};
    vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
      if (id === "play")
        return new Promise<string>((_, reject) => {
          sever = reject;
        });
      if (id === "pause") return { currentTime: 3, duration: 30 };
      return "ok";
    });
    await transport.startReading("Sever me.");
    await untilStatus("playing");
    if (pauseFirst) await transport.pause();

    sever(new Error("The message port closed before a response was received."));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(await readPlayback()).toEqual(after);
    expect(vi.mocked(surfaceError).mock.calls.map(([error]) => error)).toEqual(surfaced);
  });
});
