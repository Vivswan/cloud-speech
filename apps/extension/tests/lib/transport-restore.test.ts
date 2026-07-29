import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";

// Mock the modules transport depends on BEFORE importing it.
vi.mock("@/lib/synthesize", () => ({
  getAudioUri: vi.fn().mockResolvedValue("data:audio/ogg;base64,AAAA"),
}));
vi.mock("@/lib/audio-host", () => ({
  ensureAudioHost: vi.fn().mockResolvedValue(undefined),
  sendToAudioHost: vi.fn(),
  setAudioEventSink: vi.fn(),
}));
vi.mock("@/lib/messages", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/messages")>();
  return {
    ...original,
    broadcast: vi.fn(),
  };
});

import { sendToAudioHost } from "@/lib/audio-host";
import { parkedTransportItem } from "@/lib/storage";
import * as transport from "@/lib/transport";

// Own file on purpose: the restore path runs at most once per transport
// module instance, and transport.test.ts has long since consumed it.

describe("transport restore after worker recycle", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.clearAllMocks();
  });

  it("keeps the restored parked position when no live element answers getProgress", async () => {
    await parkedTransportItem.setValue({
      audioUri: "data:audio/ogg;base64,AAAA",
      text: "Parked read.",
      rate: 1.5,
      currentTime: 33,
      duration: 90,
    });
    // Recycled host: nothing is loaded, so the live read is rejected.
    vi.mocked(sendToAudioHost).mockRejectedValue(new Error("No audio loaded"));

    const state = await transport.getRestoredPlayerState();

    expect(state.status).toBe("paused");
    expect(state.rate).toBe(1.5);
    expect(state.currentTime).toBe(33);
    expect(state.duration).toBe(90);
  });
});
