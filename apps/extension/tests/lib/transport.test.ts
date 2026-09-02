import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// Mock the modules transport depends on BEFORE importing it.
vi.mock("@/lib/synthesize", () => ({
  getAudioUri: vi.fn().mockResolvedValue("data:audio/ogg;base64,AAAA"),
}));
vi.mock("@/lib/audio-host", () => ({
  ensureAudioHost: vi.fn().mockResolvedValue(undefined),
  sendToAudioHost: vi.fn(),
  setAudioEventSink: vi.fn(),
}));

import { sendToAudioHost } from "@/lib/audio-host";
import { textDigest } from "@/lib/digest";
import { broadcast } from "@/lib/messages";
import { parkedTransportItem } from "@/lib/storage";
import { getAudioUri } from "@/lib/synthesize";
import * as transport from "@/lib/transport";

vi.mock("@/lib/messages", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/messages")>();
  return {
    ...original,
    broadcast: vi.fn(),
  };
});

/** Default audio-host responses: progress-shaped for the commands the real
 *  session answers structurally, a plain ack for everything else. */
function stubAudioHost(progress: { currentTime: number; duration: number }): void {
  vi.mocked(sendToAudioHost).mockImplementation(async (id: string) =>
    id === "getProgress" || id === "seekBy" || id === "seekTo" ? progress : "ok",
  );
}

/** The generation the session would stamp its events with: the one carried
 *  by the play command the transport sent it (the real wire path). */
function lastPlayGeneration(): number {
  const call = vi
    .mocked(sendToAudioHost)
    .mock.calls.filter(([id]) => id === "play")
    .at(-1);
  if (!call) throw new Error("no play command was sent to the audio host");
  return (call[1] as { generation: number }).generation;
}

describe("transport", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.clearAllMocks();
    stubAudioHost({ currentTime: 0, duration: 0 });
    await transport.stopReading();
  });

  it("starts idle", () => {
    const state = transport.getPlayerState();
    expect(state.status).toBe("idle");
  });

  it("synthesizes the whole text once and plays one merged file", async () => {
    const started = await transport.startReading("First sentence. Second sentence.");
    expect(started).toBe(true);

    // Finished reads PARK as paused (audio stays scrubbable), never idle.
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("paused");
    });

    // One synthesis for the full text, one play, no per-sentence queue.
    expect(vi.mocked(getAudioUri)).toHaveBeenCalledTimes(1);
    const playCalls = vi.mocked(sendToAudioHost).mock.calls.filter(([id]) => id === "play");
    expect(playCalls).toHaveLength(1);
  });

  it("stopReading resets state and tells offscreen to stop", async () => {
    await transport.startReading("One. Two. Three.");
    await transport.stopReading();

    expect(transport.getPlayerState().status).toBe("idle");
    const stopCalls = vi.mocked(sendToAudioHost).mock.calls.filter(([id]) => id === "stop");
    expect(stopCalls.length).toBeGreaterThan(0);
  });

  it("setRate updates state and forwards to offscreen", async () => {
    await transport.setRate(1.5);
    expect(transport.getPlayerState().rate).toBe(1.5);
    expect(vi.mocked(sendToAudioHost)).toHaveBeenCalledWith("setRate", { rate: 1.5 });
  });

  it("keeps the chosen rate across reads instead of resetting to 1", async () => {
    await transport.setRate(1.5);
    await transport.startReading("Another read.");
    expect(transport.getPlayerState().rate).toBe(1.5);
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("paused");
    });
    const playCalls = vi.mocked(sendToAudioHost).mock.calls.filter(([id]) => id === "play");
    expect(playCalls.at(-1)?.[1]).toMatchObject({ rate: 1.5 });
  });

  it("reuses the cached merged audio for an identical read", async () => {
    await transport.startReading("Cache me.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("paused");
    });
    await transport.startReading("Cache me.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("paused");
    });
    expect(vi.mocked(getAudioUri)).toHaveBeenCalledTimes(1);
  });

  it("pause is a no-op unless playing", async () => {
    expect(await transport.pause()).toBe(false);
  });

  it("a stop landing during start's setup wins (last request, not last resume)", async () => {
    // startReading claims its generation synchronously; the stop that arrives
    // one tick later must own the final state; the read never plays.
    const started = transport.startReading("Race text.");
    const stopped = transport.stopReading();
    await Promise.all([started, stopped]);
    // Give any stale detached synthesis a chance to (incorrectly) play.
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(transport.getPlayerState().status).toBe("idle");
    const playCalls = vi.mocked(sendToAudioHost).mock.calls.filter(([id]) => id === "play");
    expect(playCalls).toHaveLength(0);
  });

  it("exposes the read's text digest so the popup can detect staleness", async () => {
    await transport.startReading("Digest me.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("paused");
    });
    expect(transport.getPlayerState().textDigest).toBe(textDigest("Digest me."));
    await transport.stopReading();
    expect(transport.getPlayerState().textDigest).toBeNull();
  });

  it("persists the parked read so a recycled worker can restore it", async () => {
    await transport.startReading("Park me.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("paused");
    });
    const parked = await parkedTransportItem.getValue();
    expect(parked?.text).toBe("Park me.");
    expect(parked?.audioUri).toContain("data:audio");

    await transport.stopReading();
    expect(await parkedTransportItem.getValue()).toBeNull();
  });

  it("a progress event landing after stopReading does not mutate idle state", async () => {
    await transport.startReading("Stop me.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("paused");
    });
    const staleStamp = lastPlayGeneration();
    await transport.stopReading();

    // Stale stamp: the event belonged to the stopped read.
    transport.updateProgress(staleStamp, { currentTime: 42, duration: 60 });
    // Even an event stamped with the post-stop generation must not
    // resurrect a timeline on an idle transport.
    transport.updateProgress(staleStamp + 1, { currentTime: 42, duration: 60 });

    const state = transport.getPlayerState();
    expect(state.status).toBe("idle");
    expect(state.currentTime).toBe(0);
    expect(state.duration).toBe(0);
  });

  it("a progress event stamped for an older read never touches the newer read's mirror", async () => {
    // Read A plays and parks; its stamp is the one the session would carry.
    await transport.startReading("Read A.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("paused");
    });
    const stampA = lastPlayGeneration();

    // Read B stays live: its play command never settles.
    vi.mocked(sendToAudioHost).mockImplementation(async (id: string) => {
      if (id === "play") return new Promise(() => {});
      return "ok";
    });
    await transport.startReading("Read B.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("playing");
    });
    const stampB = lastPlayGeneration();
    expect(stampB).not.toBe(stampA);

    // A throttled event from read A arrives while B is playing: rejected.
    transport.updateProgress(stampA, { currentTime: 42, duration: 60 });
    expect(transport.getPlayerState().currentTime).toBe(0);

    // Sanity: the same event stamped for B lands.
    transport.updateProgress(stampB, { currentTime: 42, duration: 60 });
    expect(transport.getPlayerState().currentTime).toBe(42);
  });

  it("records the session's committed seek position, not a mirror re-clamp", async () => {
    await transport.startReading("Seek me.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("paused");
    });
    // The mirror says 0/0 (the park commit adopted the stub's zeroed
    // progress). The session, which sees the real element, commits the seek
    // at face value; the transport must record THAT, not re-clamp against 0.
    expect(transport.getPlayerState().duration).toBe(0);
    stubAudioHost({ currentTime: 5, duration: 60 });

    await expect(transport.seekTo(5)).resolves.toBe(true);
    expect(transport.getPlayerState().currentTime).toBe(5);
    expect(transport.getPlayerState().duration).toBe(60);

    await expect(transport.seekBy(3)).resolves.toBe(true);
    expect(transport.getPlayerState().currentTime).toBe(5);
  });

  it("pause parks and broadcasts the element's live position, not the throttled mirror", async () => {
    // Keep the play pending so the read stays "playing" while we pause it.
    vi.mocked(sendToAudioHost).mockImplementation(async (id: string) => {
      if (id === "play") return new Promise(() => {});
      if (id === "getProgress") return { currentTime: 12.5, duration: 60 };
      return "ok";
    });
    await transport.startReading("Pause me.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("playing");
    });
    // Throttled mirror trails the element by up to 400ms.
    transport.updateProgress(lastPlayGeneration(), { currentTime: 10, duration: 60 });

    await expect(transport.pause()).resolves.toBe(true);

    expect(transport.getPlayerState().currentTime).toBe(12.5);
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith(
      "playerState",
      expect.objectContaining({ status: "paused", currentTime: 12.5 }),
    );
    const parked = await parkedTransportItem.getValue();
    expect(parked?.currentTime).toBe(12.5);
  });

  it("notifyEnded's detached park never persists a newer read that started meanwhile", async () => {
    let releaseProgress: (progress: { currentTime: number; duration: number }) => void = () => {};
    vi.mocked(sendToAudioHost).mockImplementation(async (id: string) => {
      if (id === "play") return new Promise(() => {});
      if (id === "getProgress")
        return new Promise((resolve) => {
          releaseProgress = resolve;
        });
      return "ok";
    });

    await transport.startReading("Read A.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("playing");
    });
    const stampA = lastPlayGeneration();

    // Natural end: parks synchronously, then commits the live position
    // detached. A new read starts BEFORE that commit resolves.
    expect(transport.notifyEnded(stampA)).toBe(true);
    await transport.startReading("Read B.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("playing");
    });

    releaseProgress({ currentTime: 99, duration: 100 });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Read B is live, not parked; the orphaned commit must not snapshot it.
    expect(await parkedTransportItem.getValue()).toBeNull();
  });

  it("the recycle-replay fallback resets the position to 0 and broadcasts it", async () => {
    await transport.startReading("Recycle me.");
    await vi.waitFor(() => {
      expect(transport.getPlayerState().status).toBe("paused");
    });
    const originalStamp = lastPlayGeneration();
    transport.updateProgress(originalStamp, { currentTime: 30, duration: 60 });
    expect(transport.getPlayerState().currentTime).toBe(30);

    // Chrome recycled the offscreen document: resume is rejected and the
    // transport replays the cached audio from scratch.
    vi.mocked(sendToAudioHost).mockImplementation(async (id: string) => {
      if (id === "resume") throw new Error("Nothing loaded to resume");
      if (id === "getProgress") return { currentTime: 0, duration: 60 };
      return "ok";
    });
    vi.mocked(broadcast).mockClear();

    await expect(transport.resume()).resolves.toBe(true);
    expect(transport.getPlayerState().currentTime).toBe(0);
    expect(vi.mocked(broadcast)).toHaveBeenCalledWith(
      "playerProgress",
      expect.objectContaining({ currentTime: 0 }),
    );

    // The replay itself goes out stamped with the freshly claimed generation:
    // newer than the original read's, and live (a progress event carrying it
    // is accepted by the transport).
    await vi.waitFor(() => {
      expect(lastPlayGeneration()).toBeGreaterThan(originalStamp);
    });
    const replayStamp = lastPlayGeneration();
    transport.updateProgress(replayStamp, { currentTime: 1, duration: 60 });
    expect(transport.getPlayerState().currentTime).toBe(1);
  });
});
