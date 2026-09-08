import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// End-to-end coverage of the background's download route: the production
// dispatcher, the dedupe registry, download() and getAudioUri run for real;
// the provider, the audio host, the downloads API and the bootstrap chores
// are mocked.

const { fakeProvider } = vi.hoisted(() => {
  const audioFormats = [
    {
      id: "OGG_OPUS",
      mimeType: "audio/ogg",
      extension: "ogg",
      stitchable: true,
      forDownload: true,
      forReadAloud: true,
    },
    {
      id: "MP3",
      mimeType: "audio/mpeg",
      extension: "mp3",
      stitchable: true,
      forDownload: true,
      forReadAloud: true,
    },
  ] as const;
  const range = { min: 0.5, max: 4, default: 1, step: 0.1 };
  // Reports the format it was asked for, the way every real provider does
  // after chunking; the file name is derived from that report.
  const synthesize = vi.fn(
    async (
      args: import("@/providers/types").SynthesizeArgs,
    ): Promise<import("@/providers/types").SynthResult> => {
      const format = audioFormats.find((f) => f.id === args.encoding);
      if (!format) throw new Error(`unknown encoding ${args.encoding}`);
      return { bytes: new Uint8Array([1, 2, 3]), ...format };
    },
  );
  const fakeProvider = {
    id: "polly",
    audioFormats,
    hasCredentials: () => true,
    synthesize,
    ranges: () => ({ speed: range, pitch: range, volumeGainDb: range }),
  } satisfies Pick<
    import("@/providers/types").TtsProvider,
    "id" | "audioFormats" | "hasCredentials" | "synthesize" | "ranges"
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
vi.mock("@/lib/errors", () => ({ surfaceError: vi.fn(async () => {}) }));
vi.mock("@/lib/audio-host", () => ({
  ensureAudioHost: vi.fn(async () => {}),
  sendToAudioHost: vi.fn(async () => "ok"),
}));
vi.mock("idb-keyval", () => ({
  createStore: () => "store",
  get: async () => undefined,
  set: async () => {},
  del: async () => {},
}));

import background from "@/entrypoints/background";
import { surfaceError } from "@/lib/errors";
import { patchPlaybackRate } from "@/lib/playback";
import {
  SETTINGS_VERSION,
  type SettingsInput,
  SettingsSchema,
  setSettings,
  voicesSessionItem,
} from "@/lib/storage";

const CREDENTIALS = {
  accessKeyId: "EXAMPLEKEY0DOWNLOAD",
  secretAccessKey: "EXAMPLE-secret-not-real",
  region: "us-east-1",
};

// The read-aloud and download formats differ on purpose: a download that
// resolves the wrong purpose produces a file with the other extension.
const SETTINGS: SettingsInput = {
  schemaVersion: SETTINGS_VERSION,
  selection: { providerId: "polly", voiceId: "Joanna", model: "neural", style: "calm" },
  perProvider: {
    polly: {
      credentials: CREDENTIALS,
      enabled: true,
      verified: true,
      readAloudEncoding: "OGG_OPUS",
      downloadEncoding: "MP3",
    },
  },
  speed: 1.25,
  pitch: -2,
  volumeGainDb: 3,
  // Differs from the cached voice's language: the request carries the voice's.
  language: "de-DE",
};

// Wired once, NO fakeBrowser.reset(): a reset would detach the background's
// message listener with no way to re-register it.
beforeAll(() => {
  Object.assign(fakeBrowser, {
    contextMenus: {
      removeAll: vi.fn(async () => {}),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: { onCommand: { addListener: vi.fn() } },
    downloads: { download: vi.fn(async () => 1) },
  });
  background.main();
});

beforeEach(async () => {
  fakeProvider.synthesize.mockClear();
  vi.mocked(fakeBrowser.downloads.download).mockClear();
  vi.mocked(surfaceError).mockClear();
  await setSettings(SettingsSchema.parse(SETTINGS));
  await voicesSessionItem.setValue([
    {
      id: "Joanna",
      providerId: "polly",
      displayName: "Joanna",
      languageCodes: ["en-GB"],
      gender: "female",
      models: ["neural"],
    },
  ]);
  // The mini-player rate the user picked; it outlives the read it was set in.
  await patchPlaybackRate(1.5);
});

function send(id: "download" | "readAloud" | "stopReading", text?: string): Promise<unknown> {
  return fakeBrowser.runtime.sendMessage({
    to: "background",
    id,
    payload: text === undefined ? undefined : { text },
  });
}

const synthesized = () => fakeProvider.synthesize.mock.calls.map(([args]) => args);

describe("background download", () => {
  it("names the file and the data URL after the download format's extension, while a read of the same text keeps the read-aloud format", async () => {
    expect(await send("download", "Download me")).toEqual({ ok: true, value: true });
    await send("readAloud", "Download me");
    await vi.waitFor(() => {
      expect(synthesized().map((args) => args.encoding)).toEqual(["MP3", "OGG_OPUS"]);
    });

    expect(fakeBrowser.downloads.download).toHaveBeenCalledTimes(1);
    expect(fakeBrowser.downloads.download).toHaveBeenCalledWith({
      url: expect.stringMatching(/^data:audio\/mp3;base64,/),
      filename: "tts-download.mp3",
    });
    await send("stopReading");
  });

  it("synthesizes the file with the selected voice, engine and style at the settings speed times the player rate", async () => {
    expect(await send("download", "Read <b>this</b> & that")).toEqual({ ok: true, value: true });

    const [request] = synthesized();
    expect(request).toEqual({
      text: "Read this & that",
      voiceId: "Joanna",
      model: "neural",
      style: "calm",
      language: "en-GB",
      encoding: "MP3",
      speed: 1.25 * 1.5,
      pitch: -2,
      volumeGainDb: 3,
      credentials: CREDENTIALS,
      signal: expect.any(AbortSignal),
    });
  });

  it("completes the file when a read starts and stops during its synthesis", async () => {
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Like fetch: the held request settles when released or when its signal aborts.
    fakeProvider.synthesize.mockImplementationOnce(async (args) => {
      await Promise.race([
        held,
        new Promise<never>((_, reject) => {
          args.signal.addEventListener("abort", () => reject(args.signal.reason));
        }),
      ]);
      return { bytes: new Uint8Array([1]), mimeType: "audio/mpeg", extension: "mp3" };
    });

    const reply = send("download", "Long download");
    await vi.waitFor(() => {
      expect(synthesized()).toHaveLength(1);
    });
    const [download] = synthesized();

    expect(await send("readAloud", "Something else")).toEqual({ ok: true, value: true });
    await vi.waitFor(() => {
      expect(synthesized()).toHaveLength(2);
    });
    expect(await send("stopReading")).toEqual({ ok: true, value: true });
    expect(download?.signal.aborted).toBe(false);

    release();
    expect(await reply).toEqual({ ok: true, value: true });
    expect(fakeBrowser.downloads.download).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "tts-download.mp3" }),
    );
    expect(surfaceError).not.toHaveBeenCalled();
  });

  it.each([
    {
      failure: "the provider rejects",
      arrange: () => {
        fakeProvider.synthesize.mockImplementationOnce(async () => {
          throw new Error("Provider says: quota exceeded");
        });
      },
      surfaced: { message: "Provider says: quota exceeded" },
      providerCalls: 1,
    },
    {
      failure: "no voice is selected",
      arrange: () => setSettings(SettingsSchema.parse({ ...SETTINGS, selection: null })),
      surfaced: { name: "NoVoiceSelectedError" },
      providerCalls: 0,
    },
  ])("answers false, surfaces the error and downloads nothing when $failure", async (scenario) => {
    await scenario.arrange();

    expect(await send("download", "Download me")).toEqual({ ok: true, value: false });

    expect(synthesized()).toHaveLength(scenario.providerCalls);
    expect(surfaceError).toHaveBeenCalledTimes(1);
    expect(surfaceError).toHaveBeenCalledWith(expect.objectContaining(scenario.surfaced));
    expect(fakeBrowser.downloads.download).not.toHaveBeenCalled();
  });
});
