import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// End-to-end coverage of the background's preview slot (session:preview):
// the production dispatcher + previewVoice (whose second press on the row
// auditioning is the stop) run for real; only the edges (provider, audio
// host, bootstrap chores) are mocked.

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
vi.mock("@/migrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/migrations")>()),
  runStartupMigrations: vi.fn(async () => {}),
}));
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
const DESCRIBED = { title: "errors.read_failed_title", message: "described", detail: "d" };
vi.mock("@/lib/errors", () => ({
  surfaceError: vi.fn(async () => {}),
  describeFailureWithoutCredentials: vi.fn(async () => DESCRIBED),
}));
vi.mock("@/lib/audio-host", () => ({
  ensureAudioHost: vi.fn(async () => {}),
  sendToAudioHost: vi.fn(async () => "ok"),
}));

import background from "@/entrypoints/background";
import { sendToAudioHost } from "@/lib/audio-host";
import { describeFailureWithoutCredentials, surfaceError } from "@/lib/errors";
import { readPreview, watchPreview } from "@/lib/playback";
import { readVoiceIssues, updateSettings, type VoiceModelRef, voiceIssue } from "@/lib/storage";

/** Every value the preview slot took, in order: the row that started
 *  auditioning, then null when it settled. */
const previews: (VoiceModelRef | null)[] = [];

function row(voiceId: string): VoiceModelRef {
  return { providerId: "polly", voiceId, model: "neural" };
}

// Wired once, NO fakeBrowser.reset(): a reset would detach the background's
// message listener (and this recorder) with no way to re-register them.
beforeAll(async () => {
  Object.assign(fakeBrowser, {
    contextMenus: {
      removeAll: vi.fn(async () => {}),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
  });
  // A preview the previous (dead) background context left published.
  await fakeBrowser.storage.session.set({ preview: row("Orphan") });
  expect(await readPreview()).toEqual(row("Orphan"));
  watchPreview((preview) => previews.push(preview));
  background.main();
});

/** The background handler answers via sendResponse, but these tests observe
 *  outcomes via the preview slot + waitFor rather than the sendMessage reply. */
function sendPreview(voiceId: string): Promise<unknown> {
  return fakeBrowser.runtime.sendMessage({
    to: "background",
    id: "previewVoice",
    payload: { providerId: "polly", voiceId, model: "neural", language: "en-US" },
  });
}

describe("background preview slot", () => {
  beforeEach(() => {
    previews.splice(0);
    vi.mocked(surfaceError).mockClear();
    vi.mocked(sendToAudioHost).mockClear();
    vi.mocked(sendToAudioHost).mockImplementation(async () => "ok");
  });

  it("a fresh background clears a preview a dead context left published", async () => {
    await vi.waitFor(async () => {
      expect(await readPreview()).toBeNull();
    });
  });

  it("a second press cancels an in-flight synthesis: no play, no error, no voice issue, slot cleared once", async () => {
    void sendPreview("Slow");
    await vi.waitFor(() => {
      expect(fakeProvider.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ voiceId: "Slow" }),
      );
    });
    const signal = fakeProvider.synthesize.mock.calls.at(-1)?.[0].signal;
    expect(signal?.aborted).toBe(false);

    await sendPreview("Slow");
    expect(signal?.reason).toMatchObject({ name: "AbortError", message: "released" });
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(previews).toEqual([row("Slow"), null]);
    expect(surfaceError).not.toHaveBeenCalled();
    expect(sendToAudioHost).not.toHaveBeenCalledWith("previewPlay", expect.anything());
    expect(voiceIssue(await readVoiceIssues(), row("Slow"))).toBeUndefined();
  });

  it("publishes the row while it auditions and clears it on natural end", async () => {
    vi.mocked(sendToAudioHost).mockImplementation(async (id) =>
      id === "previewPlay" ? "Preview finished" : "ok",
    );
    await sendPreview("Joanna");
    await vi.waitFor(() => {
      expect(previews).toEqual([row("Joanna"), null]);
    });
  });

  it("clears the row when synthesis fails, surfacing and recording the failure as a preview of that voice's provider", async () => {
    await sendPreview("Broken");
    await vi.waitFor(() => {
      expect(previews).toEqual([row("Broken"), null]);
    });
    const context = { providerId: "polly", operation: "preview" };
    expect(surfaceError).toHaveBeenCalledExactlyOnceWith(expect.anything(), context);
    // The recorded issue is described with the same context the notice was.
    expect(describeFailureWithoutCredentials).toHaveBeenCalledExactlyOnceWith(
      expect.anything(),
      context,
    );
    expect(voiceIssue(await readVoiceIssues(), row("Broken"))).toEqual(DESCRIBED);
  });

  it("clears the row when a second press stops playback, exactly once", async () => {
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

    await sendPreview("Matthew");
    await vi.waitFor(() => {
      expect(previews).toEqual([row("Matthew"), null]);
    });

    // The stopped preview's previewPlay settles as interrupted; its finally
    // sees the aborted signal, so the slot is not written again.
    settle("Preview interrupted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(previews).toEqual([row("Matthew"), null]);
  });

  it("a second press on the row auditioning stops it instead of restarting; the row starts again after", async () => {
    vi.mocked(sendToAudioHost).mockImplementation(async (id) =>
      id === "previewPlay" ? "Preview finished" : "ok",
    );
    const synthesized = () =>
      fakeProvider.synthesize.mock.calls.filter(([args]) => args.voiceId === "Ivy").length;
    const before = synthesized();

    // Both presses arrive before the first's row write lands, exactly as two
    // quick clicks on one popup button do: the slot, not the popup, decides.
    await Promise.all([sendPreview("Ivy"), sendPreview("Ivy")]);

    expect(synthesized()).toBe(before + 1);
    expect(sendToAudioHost).toHaveBeenCalledWith("previewStop");
    expect(sendToAudioHost).not.toHaveBeenCalledWith("previewPlay", expect.anything());
    expect(surfaceError).not.toHaveBeenCalled();
    expect(previews).toEqual([row("Ivy"), null]);
    expect(await readPreview()).toBeNull();

    // The stop cleared the held row too: the same row is a fresh start now.
    await sendPreview("Ivy");
    await vi.waitFor(() => {
      expect(previews).toEqual([row("Ivy"), null, row("Ivy"), null]);
    });
    expect(sendToAudioHost).toHaveBeenCalledWith(
      "previewPlay",
      expect.objectContaining({ audioUri: expect.stringContaining("data:") }),
    );
  });

  it("hands the slot to a newer preview without the older one clearing it", async () => {
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
    // preview owns the slot, so the older one leaves it alone.
    settles[0]?.("Preview interrupted");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(previews).toEqual([row("Amy"), row("Brian")]);

    settles[1]?.("Preview finished");
    await vi.waitFor(() => {
      expect(previews).toEqual([row("Amy"), row("Brian"), null]);
    });
  });

  it("replays a cached preview only under the credentials that produced it", async () => {
    vi.mocked(sendToAudioHost).mockImplementation(async (id) =>
      id === "previewPlay" ? "Preview finished" : "ok",
    );
    const synthesized = () =>
      fakeProvider.synthesize.mock.calls.filter(([args]) => args.voiceId === "Kendra");
    const storeKey = (accessKeyId: string) =>
      updateSettings({
        perProvider: {
          polly: {
            credentials: { accessKeyId, secretAccessKey: "s3cret", region: "us-east-1" },
            enabled: true,
            verified: false,
          },
        },
      });

    await storeKey("AKIA-first");
    await sendPreview("Kendra");
    expect(synthesized()).toHaveLength(1);
    await sendPreview("Kendra");
    expect(synthesized()).toHaveLength(1);

    // Same voice and model, another key: the first key's audio must not answer.
    await storeKey("AKIA-second");
    await sendPreview("Kendra");
    expect(synthesized()).toHaveLength(2);
    expect(synthesized()[1]?.[0].credentials).toMatchObject({ accessKeyId: "AKIA-second" });

    await sendPreview("Kendra");
    expect(synthesized()).toHaveLength(2);
    // Cached or fresh, every press played.
    expect(
      vi.mocked(sendToAudioHost).mock.calls.filter(([id]) => id === "previewPlay"),
    ).toHaveLength(4);
  });
});
