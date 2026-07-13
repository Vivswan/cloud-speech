import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AudioSessionEmit, createAudioSession } from "@/lib/audio-session";
import { FakeAudio } from "../helpers/fake-audio";

function createSession(emit: AudioSessionEmit = vi.fn()) {
  vi.stubGlobal("Audio", FakeAudio);
  const handlers = createAudioSession(emit);
  const main = FakeAudio.instances.at(-2) as FakeAudio;
  const preview = FakeAudio.instances.at(-1) as FakeAudio;
  return { handlers, main, preview };
}

describe("audio-session", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it("play loads the source, autoplays on metadata, and resolves on end", async () => {
    const { handlers, main } = createSession();
    const play = handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1.5 });

    expect(main.src).toBe("data:audio/ogg;base64,AAAA");
    expect(main.playbackRate).toBe(1.5);

    main.duration = 10;
    main.onloadedmetadata?.();
    expect(main.paused).toBe(false);

    main.end();
    await expect(play).resolves.toBe("Finished playing");
  });

  it("a newer play settles the pending one as interrupted", async () => {
    const { handlers, main } = createSession();
    const first = handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1 });
    const second = handlers.play?.({ audioUri: "data:audio/ogg;base64,BBBB", rate: 1 });

    await expect(first).resolves.toBe("Playback interrupted");
    main.onloadedmetadata?.();
    main.end();
    await expect(second).resolves.toBe("Finished playing");
  });

  it("stop settles the pending play and unloads the source", async () => {
    const { handlers, main } = createSession();
    const play = handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1 });

    await expect(handlers.stop?.()).resolves.toBe("Stopped audio");
    await expect(play).resolves.toBe("Playback interrupted");
    expect(main.src).toBe("");
  });

  it("a pause arriving before metadata suppresses the deferred autoplay", async () => {
    const { handlers, main } = createSession();
    void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1 });

    await handlers.pause?.();
    main.onloadedmetadata?.();
    expect(main.paused).toBe(true);
  });

  it("resume rejects when nothing is loaded (recycled context)", async () => {
    const { handlers } = createSession();
    await expect(handlers.resume?.()).rejects.toThrow("Nothing loaded to resume");
  });

  it("seeks reject without seekable audio and clamp within duration", async () => {
    const { handlers, main } = createSession();
    await expect(handlers.seekBy?.({ seconds: 15 })).rejects.toThrow("No seekable audio loaded");

    main.duration = 30;
    main.currentTime = 25;
    await expect(handlers.seekBy?.({ seconds: 15 })).resolves.toBe("Seeked");
    expect(main.currentTime).toBe(30);

    await expect(handlers.seekTo?.({ seconds: -5 })).resolves.toBe("Seeked");
    expect(main.currentTime).toBe(0);
  });

  it("emits playbackEnded through the persistent ended listener", async () => {
    const emit = vi.fn();
    const { handlers, main } = createSession(emit);
    void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1 });
    main.onloadedmetadata?.();
    main.end();
    expect(emit).toHaveBeenCalledWith("playbackEnded", undefined);
  });

  it("previews emit previewEnded on finish and on stop, without touching main", async () => {
    const emit = vi.fn();
    const { handlers, main, preview } = createSession(emit);

    const first = handlers.previewPlay?.({ audioUri: "data:audio/mp3;base64,AAAA" });
    expect(preview.src).toBe("data:audio/mp3;base64,AAAA");
    expect(main.src).toBe("");

    preview.end();
    await expect(first).resolves.toBe("Preview finished");
    expect(emit).toHaveBeenCalledWith("previewEnded", {});

    void handlers.previewPlay?.({ audioUri: "data:audio/mp3;base64,BBBB" });
    await expect(handlers.previewStop?.()).resolves.toBe("Preview stopped");
    expect(preview.paused).toBe(true);
  });

  it("getProgress reports the main channel's position", async () => {
    const { handlers, main } = createSession();
    main.currentTime = 12;
    main.duration = 60;
    await expect(handlers.getProgress?.()).resolves.toBe(
      JSON.stringify({ currentTime: 12, duration: 60 }),
    );
  });
});
