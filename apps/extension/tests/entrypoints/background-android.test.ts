import { LEGACY_IDS } from "@cloud-speech/constants";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// The background on a browser without the context menu and commands APIs
// (Firefox for Android): the bootstrap must complete and the popup's routes
// must work, with neither namespace ever touched. The production dispatcher,
// the read transport and getAudioUri run for real; the provider, the audio
// host and the bootstrap chores are mocked.

const { fakeProvider } = vi.hoisted(() => {
  const audioFormats = [
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
  const synthesize = vi.fn(
    async (
      _args: import("@/providers/types").SynthesizeArgs,
    ): Promise<import("@/providers/types").SynthResult> => ({
      bytes: new Uint8Array([1, 2, 3]),
      ...audioFormats[0],
    }),
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
// main() runs in beforeAll and Vitest clears mock call history before each
// test, so whether the background subscribed is kept here, not in the mock.
const locale = vi.hoisted(() => ({ subscribed: false }));
vi.mock("@/lib/i18n-runtime", () => ({
  i18n: { t: (key: string) => key },
  initI18n: vi.fn(async () => {}),
  subscribeLocale: vi.fn(() => {
    locale.subscribed = true;
  }),
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
import { readPlayback } from "@/lib/playback";
import {
  SETTINGS_VERSION,
  type SettingsInput,
  SettingsSchema,
  setSettings,
  voicesSessionItem,
} from "@/lib/storage";
import { handoffBannerItem } from "@/migrations/handoff/state";

const SETTINGS: SettingsInput = {
  schemaVersion: SETTINGS_VERSION,
  selection: { providerId: "polly", voiceId: "Joanna", model: "neural" },
  perProvider: {
    polly: {
      credentials: {
        accessKeyId: "EXAMPLEKEY0ANDROID",
        secretAccessKey: "EXAMPLE-secret-not-real",
        region: "us-east-1",
      },
      enabled: true,
      verified: true,
    },
  },
};

/** The fake browser as Firefox for Android exposes it: no contextMenus, no
 *  commands namespace at all (not an object with missing methods). */
function removeMenuAndCommandApis(): void {
  const apis = fakeBrowser as { contextMenus?: unknown; commands?: unknown };
  delete apis.contextMenus;
  delete apis.commands;
}

// The menu chain reports a failed change through console.warn rather than
// rejecting, so a menu call reaching the absent namespace shows up only here.
const warned = vi.spyOn(console, "warn");
const errored = vi.spyOn(console, "error");

// Wired once, NO fakeBrowser.reset(): a reset would detach the background's
// message listener with no way to re-register it. The listener registration
// itself is under test: main() throws here if it reaches either namespace.
// A fork listing id, so retirement (which clears the menus) can be exercised.
beforeAll(() => {
  removeMenuAndCommandApis();
  fakeBrowser.runtime.id = LEGACY_IDS[0] ?? "";
  background.main();
});

beforeEach(async () => {
  fakeProvider.synthesize.mockClear();
  vi.mocked(surfaceError).mockClear();
  warned.mockClear();
  errored.mockClear();
  await setSettings(SettingsSchema.parse(SETTINGS));
  await voicesSessionItem.setValue([
    {
      id: "Joanna",
      providerId: "polly",
      displayName: "Joanna",
      languageCodes: ["en-US"],
      gender: "female",
      models: ["neural"],
    },
  ]);
});

function send(id: "fetchVoices" | "readAloud" | "stopReading", text?: string): Promise<unknown> {
  return fakeBrowser.runtime.sendMessage({
    to: "background",
    id,
    payload: text === undefined ? undefined : { text },
  });
}

describe("background without the context menu and commands APIs", () => {
  it("bootstraps without touching either namespace: a gated route answers and nothing is logged", async () => {
    expect(await send("fetchVoices")).toEqual({ ok: true, value: 0 });
    expect((fakeBrowser as { contextMenus?: unknown }).contextMenus).toBeUndefined();
    expect((fakeBrowser as { commands?: unknown }).commands).toBeUndefined();
    expect(warned).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
  });

  it("retires quietly: the menu clearing has nothing to reach for", async () => {
    await handoffBannerItem.setValue({ dismissedAt: null, imported: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(warned).not.toHaveBeenCalled();
    expect(errored).not.toHaveBeenCalled();
  });

  it("skips the menu rebuild on locale changes: nothing subscribes", () => {
    expect(locale.subscribed).toBe(false);
  });

  it("reads aloud and stops through the popup's routes", async () => {
    expect(await send("readAloud", "Read this on a phone")).toEqual({ ok: true, value: true });
    await vi.waitFor(() => {
      expect(fakeProvider.synthesize).toHaveBeenCalledTimes(1);
    });
    expect(fakeProvider.synthesize.mock.calls[0]?.[0]).toMatchObject({
      text: "Read this on a phone",
      voiceId: "Joanna",
    });
    await vi.waitFor(async () => {
      expect((await readPlayback()).status).not.toBe("idle");
    });

    expect(await send("stopReading")).toEqual({ ok: true, value: true });
    expect((await readPlayback()).status).toBe("idle");
    expect(surfaceError).not.toHaveBeenCalled();
  });
});
