import { beforeEach, describe, expect, it, vi } from "vitest";
import { type AudioSessionListeners, createAudioSession } from "@/lib/audio-session";
import { FakeAudio } from "../helpers/fake-audio";

function createSession() {
  vi.stubGlobal("Audio", FakeAudio);
  const listeners: AudioSessionListeners = {
    keepalive: vi.fn(),
    audioProgress: vi.fn(),
    audioEnded: vi.fn(),
  };
  const handlers = createAudioSession(listeners);
  const main = FakeAudio.instances.at(-2) as FakeAudio;
  const preview = FakeAudio.instances.at(-1) as FakeAudio;
  return { handlers, listeners, main, preview };
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
      epoch: 1,
    });

    expect(main.src).toBe("data:audio/ogg;base64,AAAA");
    expect(main.playbackRate).toBe(1.5);

    main.duration = 10;
    main.onloadedmetadata?.();
    expect(main.paused).toBe(false);

    main.end();
    await expect(play).resolves.toBe("Finished playing");
  });

  it.each([
    { startAt: 30, position: 30 },
    { startAt: 90, position: 60 },
  ])(
    "play starts at $startAt once the duration (60) is known, landing at $position",
    async ({ startAt, position }) => {
      const { handlers, main } = createSession();
      void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1, epoch: 1, startAt });
      expect(main.currentTime).toBe(0);

      main.duration = 60;
      main.onloadedmetadata?.();
      expect(main.currentTime).toBe(position);
      expect(main.paused).toBe(false);
    },
  );

  it("a newer play settles the pending one as interrupted", async () => {
    const { handlers, main } = createSession();
    const first = handlers.play?.({
      audioUri: "data:audio/ogg;base64,AAAA",
      rate: 1,
      epoch: 1,
    });
    const second = handlers.play?.({
      audioUri: "data:audio/ogg;base64,BBBB",
      rate: 1,
      epoch: 2,
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
      epoch: 1,
    });

    await expect(handlers.stop?.()).resolves.toBe("Stopped audio");
    await expect(play).resolves.toBe("Playback interrupted");
    expect(main.src).toBe("");
  });

  it("a pause arriving before metadata suppresses the deferred autoplay and reports no position", async () => {
    const { handlers, main } = createSession();
    void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1, epoch: 1 });

    await expect(handlers.pause?.()).resolves.toBeNull();
    main.onloadedmetadata?.();
    expect(main.paused).toBe(true);
  });

  it("a pause that arrived before the play command still suppresses its autoplay; stop clears the intent", async () => {
    const { handlers, main } = createSession();
    // The transport published "playing" while this context was still being
    // created, so the user's pause reaches an empty element first.
    await expect(handlers.pause?.()).resolves.toBeNull();

    void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1, epoch: 1 });
    main.duration = 10;
    main.onloadedmetadata?.();
    expect(main.paused).toBe(true);
    await expect(handlers.resume?.({ epoch: 1 })).resolves.toBe("Resumed");
    expect(main.paused).toBe(false);

    await handlers.pause?.();
    await handlers.stop?.();
    void handlers.play?.({ audioUri: "data:audio/ogg;base64,BBBB", rate: 1, epoch: 2 });
    main.duration = 10;
    main.onloadedmetadata?.();
    expect(main.paused).toBe(false);
  });

  it("pause resolves with the element's position once audio is loaded", async () => {
    const { handlers, main } = createSession();
    void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1, epoch: 1 });
    main.duration = 60;
    main.onloadedmetadata?.();
    main.currentTime = 12.5;

    await expect(handlers.pause?.()).resolves.toEqual({ currentTime: 12.5, duration: 60 });
    expect(main.paused).toBe(true);
  });

  it("resume rejects when nothing is loaded (recycled context) but still clears a pause intent", async () => {
    const { handlers, main } = createSession();
    await expect(handlers.pause?.()).resolves.toBeNull();
    await expect(handlers.resume?.({ epoch: 2 })).rejects.toThrow("Nothing loaded to resume");

    // The replay the transport issues next must sound.
    void handlers.play?.({
      audioUri: "data:audio/ogg;base64,AAAA",
      rate: 1,
      epoch: 2,
      startAt: 30,
    });
    main.duration = 60;
    main.onloadedmetadata?.();
    expect(main.paused).toBe(false);
    expect(main.currentTime).toBe(30);
  });

  it("a seek while the source is still loading replaces its start position", async () => {
    const { handlers, main } = createSession();
    void handlers.play?.({
      audioUri: "data:audio/ogg;base64,AAAA",
      rate: 1,
      epoch: 1,
      startAt: 30,
    });

    await expect(handlers.seekTo?.({ seconds: 50 })).resolves.toEqual({
      currentTime: 50,
      duration: 0,
    });
    main.duration = 60;
    main.onloadedmetadata?.();
    expect(main.currentTime).toBe(50);

    // Once loaded, seeks commit at once, and a stop forgets any pending start.
    await expect(handlers.seekTo?.({ seconds: 10 })).resolves.toEqual({
      currentTime: 10,
      duration: 60,
    });
    await handlers.stop?.();
    void handlers.play?.({ audioUri: "data:audio/ogg;base64,BBBB", rate: 1, epoch: 2 });
    main.duration = 60;
    main.onloadedmetadata?.();
    expect(main.currentTime).toBe(10);
  });

  it("a seek committed once the duration is known outlives a loadedmetadata that dispatches later", async () => {
    const { handlers, main } = createSession();
    void handlers.play?.({
      audioUri: "data:audio/ogg;base64,AAAA",
      rate: 1,
      epoch: 1,
      startAt: 30,
    });
    // The browser knows the duration before the queued loadedmetadata runs.
    main.duration = 60;
    await expect(handlers.seekTo?.({ seconds: 50 })).resolves.toEqual({
      currentTime: 50,
      duration: 60,
    });

    main.onloadedmetadata?.();
    expect(main.currentTime).toBe(50);
    expect(main.paused).toBe(false);
  });

  it("a pause once the duration is known reports the pending start, not the unseeked element", async () => {
    const { handlers, main } = createSession();
    void handlers.play?.({
      audioUri: "data:audio/ogg;base64,AAAA",
      rate: 1,
      epoch: 1,
      startAt: 30,
    });
    main.duration = 60;

    await expect(handlers.pause?.()).resolves.toEqual({ currentTime: 30, duration: 60 });
    main.onloadedmetadata?.();
    expect(main.currentTime).toBe(30);
    expect(main.paused).toBe(true);
  });

  it("seeks reject without audio and clamp within duration", async () => {
    const { handlers, main } = createSession();
    await expect(handlers.seekTo?.({ seconds: 15 })).rejects.toThrow("No audio loaded");

    main.src = "data:audio/ogg;base64,AAAA";
    main.duration = 30;
    await expect(handlers.seekTo?.({ seconds: 40 })).resolves.toEqual({
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

  it("stamps progress and ended events with the epoch of the owning play, one progress tick per second", async () => {
    vi.useFakeTimers();
    try {
      const { handlers, listeners, main } = createSession();
      void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1, epoch: 7 });
      main.duration = 10;
      main.onloadedmetadata?.();

      main.currentTime = 3;
      main.ontimeupdate?.();
      vi.advanceTimersByTime(400);
      main.currentTime = 3.4;
      main.ontimeupdate?.();
      expect(listeners.audioProgress).toHaveBeenCalledExactlyOnceWith({
        epoch: 7,
        currentTime: 3,
        duration: 10,
      });

      vi.advanceTimersByTime(600);
      main.currentTime = 4;
      main.ontimeupdate?.();
      expect(listeners.audioProgress).toHaveBeenCalledTimes(2);
      expect(listeners.audioProgress).toHaveBeenLastCalledWith({
        epoch: 7,
        currentTime: 4,
        duration: 10,
      });

      main.currentTime = 10;
      main.end();
      expect(listeners.audioEnded).toHaveBeenCalledExactlyOnceWith({
        epoch: 7,
        currentTime: 10,
        duration: 10,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resume adopts the replay's epoch for subsequent events", async () => {
    const { handlers, listeners, main } = createSession();
    void handlers.play?.({ audioUri: "data:audio/ogg;base64,AAAA", rate: 1, epoch: 7 });
    main.duration = 10;
    main.onloadedmetadata?.();

    await handlers.pause?.();
    await expect(handlers.resume?.({ epoch: 9 })).resolves.toBe("Resumed");

    main.currentTime = 10;
    main.end();
    expect(listeners.audioEnded).toHaveBeenCalledWith({ epoch: 9, currentTime: 10, duration: 10 });
  });

  it("previews resolve on finish and on stop without raising host events", async () => {
    const { handlers, listeners, main, preview } = createSession();

    const first = handlers.previewPlay?.({ audioUri: "data:audio/mp3;base64,AAAA" });
    expect(preview.src).toBe("data:audio/mp3;base64,AAAA");
    expect(main.src).toBe("");

    preview.end();
    await expect(first).resolves.toBe("Preview finished");

    void handlers.previewPlay?.({ audioUri: "data:audio/mp3;base64,BBBB" });
    await expect(handlers.previewStop?.()).resolves.toBe("Preview stopped");
    expect(preview.paused).toBe(true);

    // The settled previewPlay promise IS the lifecycle signal the background
    // acts on, so the session raises nothing of its own.
    expect(listeners.audioEnded).not.toHaveBeenCalled();
    expect(listeners.audioProgress).not.toHaveBeenCalled();
    expect(listeners.keepalive).not.toHaveBeenCalled();
  });
});
