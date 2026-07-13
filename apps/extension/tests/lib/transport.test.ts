import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";

// Mock the modules transport depends on BEFORE importing it.
vi.mock("@/lib/synthesize", () => ({
  getAudioUri: vi.fn().mockResolvedValue("data:audio/ogg;base64,AAAA"),
}));
vi.mock("@/lib/audio-host", () => ({
  ensureAudioHost: vi.fn().mockResolvedValue(undefined),
  sendToAudioHost: vi.fn().mockResolvedValue("ok"),
  setAudioEventSink: vi.fn(),
}));

import { sendToAudioHost } from "@/lib/audio-host";
import { textDigest } from "@/lib/digest";
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

describe("transport", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.clearAllMocks();
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

    // One synthesis for the full text, one play — no per-sentence queue.
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
    // one tick later must own the final state — the read never plays.
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
});
