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
    const play = handlers.play?.({
      audioUri: "data:audio/ogg;base64,AAAA",
      rate: 1.5,
      generation: 1,
    });

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
    const first = handlers.play?.({
      audioUri: "data:audio/ogg;base64,AAAA",
      rate: 1,
      generation: 1,
    });
    const second = handlers.play?.({
      audioUri: "data:audio/ogg;base64,BBBB",
      rate: 1,
      generation: 2,
    });

    await expect(first).resolves.toBe("Playback interrupted");
    main.onloadedmetadata?.();
    main.end();
    await expect(second).resolves.toBe("Finished playing");
  });

  it("stop settles the pending play and unloads the source", async () => {
    const { handlers, main } = createSession();
    const play = handlers.play?.({
      audioUri: "data:audio/ogg;base64,AAAA",
      rate: 1,
      generation: 1,
    });

    await expect(handlers.stop?.()).resolves.toBe("Stopped audio");
    await expect(play).resolves.toBe("Playback interrupted");
    expect(main.src).toBe("");
  });

  it("a pause arriving before metadata suppresses the deferred autoplay", async () => {
    const { handlers, main } = createSession();
    void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1, generation: 1 });

    await handlers.pause?.();
    main.onloadedmetadata?.();
    expect(main.paused).toBe(true);
  });

  it("resume rejects when nothing is loaded (recycled context)", async () => {
    const { handlers } = createSession();
    await expect(handlers.resume?.({ generation: 2 })).rejects.toThrow("Nothing loaded to resume");
  });

  it("seeks reject without seekable audio and clamp within duration", async () => {
    const { handlers, main } = createSession();
    await expect(handlers.seekBy?.({ seconds: 15 })).rejects.toThrow("No seekable audio loaded");

    main.duration = 30;
    main.currentTime = 25;
    await expect(handlers.seekBy?.({ seconds: 15 })).resolves.toEqual({
      currentTime: 30,
      duration: 30,
    });
    expect(main.currentTime).toBe(30);

    await expect(handlers.seekTo?.({ seconds: -5 })).resolves.toEqual({
      currentTime: 0,
      duration: 30,
    });
    expect(main.currentTime).toBe(0);
  });

  it("stamps progress and ended events with the generation of the owning play", async () => {
    const emit = vi.fn();
    const { handlers, main } = createSession(emit);
    void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1, generation: 7 });
    main.duration = 10;
    main.onloadedmetadata?.();

    main.currentTime = 3;
    main.ontimeupdate?.();
    expect(emit).toHaveBeenCalledWith("playerProgress", {
      generation: 7,
      currentTime: 3,
      duration: 10,
    });

    main.end();
    expect(emit).toHaveBeenCalledWith("playbackEnded", { generation: 7 });
  });

  it("resume adopts the replay's generation for subsequent events", async () => {
    const emit = vi.fn();
    const { handlers, main } = createSession(emit);
    void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1, generation: 7 });
    main.duration = 10;
    main.onloadedmetadata?.();

    await handlers.pause?.();
    await expect(handlers.resume?.({ generation: 9 })).resolves.toBe("Resumed");

    main.end();
    expect(emit).toHaveBeenCalledWith("playbackEnded", { generation: 9 });
  });

  it("previews resolve on finish and on stop without raising host events", async () => {
    const emit = vi.fn();
    const { handlers, main, preview } = createSession(emit);

    const first = handlers.previewPlay?.({ audioUri: "data:audio/mp3;base64,AAAA" });
    expect(preview.src).toBe("data:audio/mp3;base64,AAAA");
    expect(main.src).toBe("");

    preview.end();
    await expect(first).resolves.toBe("Preview finished");

    void handlers.previewPlay?.({ audioUri: "data:audio/mp3;base64,BBBB" });
    await expect(handlers.previewStop?.()).resolves.toBe("Preview stopped");
    expect(preview.paused).toBe(true);

    // The settled previewPlay promise IS the lifecycle signal; the background
    // owns the keyed previewEnded broadcast, so the session emits nothing.
    expect(emit).not.toHaveBeenCalled();
  });

  it("getProgress reports the main channel's structured position", async () => {
    const { handlers, main } = createSession();
    // Nothing loaded (recycled context): reject so the caller keeps its
    // restored mirror instead of adopting a zeroed reading.
    await expect(handlers.getProgress?.()).rejects.toThrow("No audio loaded");

    main.currentTime = 12;
    main.duration = 60;
    await expect(handlers.getProgress?.()).resolves.toEqual({ currentTime: 12, duration: 60 });
  });
});
