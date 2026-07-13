import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { sendToAudioHost, setAudioEventSink } from "@/lib/audio-host";
import { FakeAudio } from "../helpers/fake-audio";

// The suite runs twice in CI (chrome and WXT_TEST_BROWSER=firefox); each
// describe covers the branch that exists in that build.

describe.skipIf(import.meta.env.FIREFOX)("audio-host (chrome)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("tags commands with offscreen: true and unwraps the structured response", async () => {
    const seen = vi.fn();
    fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
      seen(message);
      return Promise.resolve({ ok: true, value: "ok" });
    });

    await expect(sendToAudioHost("stop")).resolves.toBe("ok");
    expect(seen).toHaveBeenCalledWith(expect.objectContaining({ id: "stop", offscreen: true }));
  });

  it("surfaces offscreen failures as rejections", async () => {
    fakeBrowser.runtime.onMessage.addListener(() => Promise.resolve({ ok: false, error: "boom" }));
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

    const progress = await sendToAudioHost("getProgress");
    expect(JSON.parse(progress)).toMatchObject({ currentTime: 0, duration: 0 });
    // No runtime message was involved; the session lives in this context.
    expect(seen).not.toHaveBeenCalled();
  });

  it("routes session events: ended → sink, progress → sink + broadcast, previewEnded → broadcast", async () => {
    const onEnded = vi.fn();
    const onProgress = vi.fn();
    setAudioEventSink({ onEnded, onProgress });
    const received: unknown[] = [];
    fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
      received.push(message);
    });

    const play = sendToAudioHost("play", { audioUri: "data:audio/ogg;base64,AAAA", rate: 1 });
    const main = FakeAudio.instances[0] as FakeAudio;
    main.duration = 10;
    main.onloadedmetadata?.();

    main.currentTime = 3;
    main.ontimeupdate?.();
    expect(onProgress).toHaveBeenCalledWith({ currentTime: 3, duration: 10 });
    expect(received).toContainEqual(expect.objectContaining({ id: "playerProgress" }));

    main.end();
    await expect(play).resolves.toBe("Finished playing");
    expect(onEnded).toHaveBeenCalled();

    await sendToAudioHost("previewStop");
    expect(received).toContainEqual(expect.objectContaining({ id: "previewEnded" }));
  });
});
