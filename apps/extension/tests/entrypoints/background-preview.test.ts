import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// End-to-end coverage of the background's keyed previewEnded events: the
// production dispatcher + previewVoice/stopPreview run for real; only the
// edges (provider, audio host, bootstrap chores) are mocked.

const { fakeProvider } = vi.hoisted(() => {
  const synthesize = vi.fn(
    async (
      args: import("@/providers/types").SynthesizeArgs,
    ): Promise<import("@/providers/types").SynthResult> => {
      if (args.voiceId === "Broken") throw new Error("Provider says: no access");
      // Like fetch: a "Slow" request only settles when its signal aborts.
      if (args.voiceId === "Slow") {
        return new Promise((_, reject) => {
          args.signal.addEventListener("abort", () => reject(args.signal.reason));
        });
      }
      return { bytes: new Uint8Array([1]), mimeType: "audio/mpeg", extension: "mp3" };
    },
  );
  const fakeProvider = {
    id: "polly",
    audioFormats: [
      {
        id: "MP3",
        mimeType: "audio/mpeg",
        extension: "mp3",
        stitchable: true,
        forDownload: true,
        forReadAloud: true,
      },
    ],
    hasCredentials: () => true,
    synthesize,
  } satisfies Pick<
    import("@/providers/types").TtsProvider,
    "id" | "audioFormats" | "hasCredentials" | "synthesize"
  >;
  return { fakeProvider };
});

vi.mock("@/providers", () => ({ providerList: [fakeProvider], getProvider: () => fakeProvider }));
vi.mock("@/migrations", () => ({ runStartupMigrations: vi.fn(async () => {}) }));
vi.mock("@/migrations/handoff", () => ({
  importHandoffOnce: vi.fn(async () => {}),
  registerHandoff: vi.fn(),
}));
vi.mock("@/lib/i18n-runtime", () => ({
  i18n: { t: (key: string) => key },
  initI18n: vi.fn(async () => {}),
  subscribeLocale: vi.fn(),
}));
vi.mock("@/lib/voices", () => ({ fetchAllVoices: vi.fn(async () => []) }));
vi.mock("@/lib/errors", () => ({ surfaceError: vi.fn(async () => {}) }));
vi.mock("@/lib/audio-host", () => ({
  ensureAudioHost: vi.fn(async () => {}),
  sendToAudioHost: vi.fn(async () => "ok"),
  setAudioEventSink: vi.fn(),
}));

import background from "@/entrypoints/background";
import { sendToAudioHost } from "@/lib/audio-host";
import { surfaceError } from "@/lib/errors";
import { voiceIssuesItem } from "@/lib/storage";

const previewEnded: { key: string }[] = [];

// Wired once, NO fakeBrowser.reset(): a reset would detach the background's
// message listener (and this recorder) with no way to re-register them.
beforeAll(() => {
  Object.assign(fakeBrowser, {
    contextMenus: {
      removeAll: vi.fn(async () => {}),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
  });
  fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
    const m = message as { to?: string; id?: string; payload?: unknown };
    if (m?.to === "popup" && m.id === "previewEnded")
      previewEnded.push(m.payload as { key: string });
  });
  background.main();
});

/** The background handler answers via sendResponse, but these tests observe
 *  outcomes via popup events + waitFor rather than the sendMessage reply. */
function sendPreview(voiceId: string): Promise<unknown> {
  return fakeBrowser.runtime.sendMessage({
    to: "background",
    id: "previewVoice",
    payload: { providerId: "polly", voiceId, model: "neural", language: "en-US" },
  });
}

describe("background preview lifecycle events", () => {
  beforeEach(() => {
    previewEnded.splice(0);
    vi.mocked(surfaceError).mockClear();
    vi.mocked(sendToAudioHost).mockClear();
    vi.mocked(sendToAudioHost).mockImplementation(async () => "ok");
  });

  it("stop cancels an in-flight synthesis: no play, no error, no voice issue, one event", async () => {
    void sendPreview("Slow");
    await vi.waitFor(() => {
      expect(fakeProvider.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ voiceId: "Slow" }),
      );
    });
    const signal = fakeProvider.synthesize.mock.calls.at(-1)?.[0].signal;
    expect(signal?.aborted).toBe(false);

    await fakeBrowser.runtime.sendMessage({ to: "background", id: "stopPreview" });
    expect(signal?.reason).toMatchObject({ name: "AbortError", message: "released" });
    await vi.waitFor(() => {
      expect(previewEnded).toContainEqual({ key: "polly:Slow:neural" });
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(previewEnded).toHaveLength(1);
    expect(surfaceError).not.toHaveBeenCalled();
    expect(sendToAudioHost).not.toHaveBeenCalledWith("previewPlay", expect.anything());
    expect((await voiceIssuesItem.getValue())["polly:Slow:neural"]).toBeUndefined();
  });

  it("announces the keyed previewEnded on natural end", async () => {
    vi.mocked(sendToAudioHost).mockImplementation(async (id) =>
      id === "previewPlay" ? "Preview finished" : "ok",
    );
    await sendPreview("Joanna");
    await vi.waitFor(() => {
      expect(previewEnded).toContainEqual({ key: "polly:Joanna:neural" });
    });
    expect(previewEnded).toHaveLength(1);
  });

  it("announces the keyed previewEnded when synthesis fails", async () => {
    await sendPreview("Broken");
    await vi.waitFor(() => {
      expect(previewEnded).toContainEqual({ key: "polly:Broken:neural" });
    });
    expect(previewEnded).toHaveLength(1);
  });

  it("announces the keyed previewEnded on stop, exactly once", async () => {
    let settle: (value: string) => void = () => {};
    vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
      if (id === "previewPlay")
        return new Promise<string>((resolve) => {
          settle = resolve;
        });
      return "ok";
    });
    void sendPreview("Matthew");
    await vi.waitFor(() => {
      expect(vi.mocked(sendToAudioHost)).toHaveBeenCalledWith(
        "previewPlay",
        expect.objectContaining({ audioUri: expect.stringContaining("data:") }),
      );
    });

    await fakeBrowser.runtime.sendMessage({ to: "background", id: "stopPreview" });
    await vi.waitFor(() => {
      expect(previewEnded).toContainEqual({ key: "polly:Matthew:neural" });
    });

    // The stopped preview's previewPlay settles as interrupted; its finally
    // is generation-gated, so no second event follows.
    settle("Preview interrupted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(previewEnded).toHaveLength(1);
  });

  it("stays silent for a preview superseded by a newer one", async () => {
    const settles: ((value: string) => void)[] = [];
    vi.mocked(sendToAudioHost).mockImplementation(async (id) => {
      if (id === "previewPlay")
        return new Promise<string>((resolve) => {
          settles.push(resolve);
        });
      return "ok";
    });
    void sendPreview("Amy");
    await vi.waitFor(() => {
      expect(settles).toHaveLength(1);
    });
    void sendPreview("Brian");
    await vi.waitFor(() => {
      expect(settles).toHaveLength(2);
    });

    // The session settles the superseded preview as interrupted; the newer
    // preview owns the row, so nothing is announced for the older key.
    settles[0]?.("Preview interrupted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(previewEnded).toHaveLength(0);

    settles[1]?.("Preview finished");
    await vi.waitFor(() => {
      expect(previewEnded).toContainEqual({ key: "polly:Brian:neural" });
    });
    expect(previewEnded).toHaveLength(1);
  });
});
