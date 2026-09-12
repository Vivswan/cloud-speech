import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { sendToAudioHost } from "@/lib/audio-host";
import { type Playback, readPlayback } from "@/lib/playback";
import { FakeAudio } from "../helpers/fake-audio";

// The suite runs twice in CI (chrome and WXT_TEST_BROWSER=firefox); each
// describe covers the branch that exists in that build.

describe.skipIf(import.meta.env.FIREFOX)("audio-host (chrome)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("addresses commands to the audio target and unwraps the structured reply", async () => {
    const seen = vi.fn();
    fakeBrowser.runtime.onMessage.addListener(
      (message: unknown, _sender, sendResponse: (response?: unknown) => void) => {
        seen(message);
        sendResponse({ ok: true, value: "ok" });
        return true;
      },
    );

    await expect(sendToAudioHost("stop")).resolves.toBe("ok");
    expect(seen).toHaveBeenCalledWith({ to: "audio", id: "stop", payload: undefined });
  });

  it("surfaces offscreen failures as rejections", async () => {
    fakeBrowser.runtime.onMessage.addListener(
      (_message: unknown, _sender, sendResponse: (response?: unknown) => void) => {
        sendResponse({ ok: false, error: "boom" });
        return true;
      },
    );
    await expect(sendToAudioHost("stop")).rejects.toThrow("boom");
  });
});

describe.skipIf(!import.meta.env.FIREFOX)("audio-host (firefox)", () => {
  beforeAll(() => {
    // Must be in place BEFORE the first sendToAudioHost creates the lazy
    // singleton session; its Audio elements are constructed exactly once.
    vi.stubGlobal("Audio", FakeAudio);
  });

  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("dispatches directly to the in-background session (no messaging)", async () => {
    const seen = vi.fn();
    fakeBrowser.runtime.onMessage.addListener(seen);

    await expect(sendToAudioHost("stop")).resolves.toBe("Stopped audio");
    expect(seen).not.toHaveBeenCalled();
  });

  it("applies the session's stamped position events straight to the playback document", async () => {
    const playing: Playback = {
      status: "playing",
      epoch: 5,
      rate: 1,
      textDigest: "abc:12",
      currentTime: 0,
      duration: 0,
    };
    await fakeBrowser.storage.session.set({ playback: playing });
    const received: unknown[] = [];
    fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
      received.push(message);
    });

    const play = sendToAudioHost("play", {
      audioUri: "data:audio/ogg;base64,AAAA",
      rate: 1,
      epoch: 5,
    });
    const main = FakeAudio.instances[0] as FakeAudio;
    main.duration = 10;
    main.onloadedmetadata?.();

    main.currentTime = 3;
    main.ontimeupdate?.();
    await vi.waitFor(async () => {
      expect(await readPlayback()).toEqual({ ...playing, currentTime: 3, duration: 10 });
    });

    main.currentTime = 10;
    main.end();
    await expect(play).resolves.toBe("Finished playing");
    await vi.waitFor(async () => {
      expect(await readPlayback()).toEqual({
        ...playing,
        status: "paused",
        currentTime: 10,
        duration: 10,
      });
    });

    expect(received).toEqual([]);

    // Preview lifecycle is background-owned; the session raises no event for it.
    await sendToAudioHost("previewStop");
    expect(received).toEqual([]);
  });
});
