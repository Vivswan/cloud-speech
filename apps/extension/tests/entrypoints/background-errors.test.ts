import { PROVIDER_NAMES, type ProviderId } from "@cloud-speech/constants";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

// The production dispatcher, read transport and error classifier (lib/errors.ts) run together over the mocks below.
// Notices are read as they leave for the popup banner and the tab's toast, so a call site that forgets the provider context shows up as the generic wording.

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
  // Like fetch when the network is down: the request never gets an answer.
  const synthesize = vi.fn(
    async (
      args: import("@/providers/types").SynthesizeArgs,
    ): Promise<import("@/providers/types").SynthResult> => {
      if (args.voiceId === "Unreachable" || args.text.includes("unreachable")) {
        throw new TypeError("Failed to fetch");
      }
      // Like a server that quotes the key it rejected.
      if (args.text.includes("echo the key") || args.voiceId === "Echo") {
        throw new Error(`Rejected credential ${args.credentials.accessKeyId}`);
      }
      return { bytes: new Uint8Array([1]), ...audioFormats[0] };
    },
  );
  // The schema names which stored values are secrets, so a surfaced detail can blank them; a double without one would skip that step silently.
  const credentialSchema = ["accessKeyId", "secretAccessKey", "region"].map((key) => ({
    key,
    labelKey: `providers.polly.${key}`,
    placeholder: "",
    type: "password" as const,
  }));
  const fakeProvider = {
    id: "polly",
    audioFormats,
    credentialSchema,
    hasCredentials: () => true,
    synthesize,
    ranges: () => ({ speed: range, pitch: range, volumeGainDb: range }),
  } satisfies Pick<
    import("@/providers/types").TtsProvider,
    "id" | "audioFormats" | "credentialSchema" | "hasCredentials" | "synthesize" | "ranges"
  >;
  return { fakeProvider };
});

// getProvider honours the id it is asked for, so a notice built from the wrong context names the wrong provider instead of Polly by accident.
vi.mock("@/providers", () => ({
  providerList: [fakeProvider],
  getProvider: (id: string) => ({ ...fakeProvider, id }),
}));
vi.mock("@/migrations", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/migrations")>()),
  runStartupMigrations: vi.fn(async () => {}),
}));
vi.mock("@/migrations/handoff", () => ({
  importHandoffOnce: vi.fn(async () => {}),
  registerHandoff: vi.fn(),
}));
// Keys, not sentences, with the substitutions in brackets: the notice is asserted by which message it picked and whose name it filled in.
vi.mock("@/lib/i18n-runtime", () => ({
  i18n: { t: (key: string, subs?: string[]) => (subs?.length ? `${key}[${subs.join("|")}]` : key) },
  tDynamic: (key: string, subs?: string[]) => (subs?.length ? `${key}[${subs.join("|")}]` : key),
  initI18n: vi.fn(async () => {}),
  subscribeLocale: vi.fn(),
}));
vi.mock("@/lib/voices", () => ({ fetchAllVoices: vi.fn(async () => []) }));
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
import type { BackgroundErrorEvent } from "@/lib/protocol";
import {
  readVoiceIssues,
  SETTINGS_VERSION,
  type SettingsInput,
  SettingsSchema,
  setSettings,
  voiceIssue,
  voiceIssuesItem,
  voicesSessionItem,
} from "@/lib/storage";

const SETTINGS: SettingsInput = {
  schemaVersion: SETTINGS_VERSION,
  selection: { providerId: "polly", voiceId: "Joanna", model: "neural" },
  perProvider: {
    polly: {
      // A key the redaction by shape misses (no AKIA prefix, no key=value form, under 40 characters): only blanking the value itself hides it.
      credentials: {
        accessKeyId: "EXAMPLEKEY0ERRORS",
        secretAccessKey: "EXAMPLE-secret-not-real",
        region: "us-east-1",
      },
      enabled: true,
      verified: true,
      readAloudEncoding: "MP3",
      downloadEncoding: "MP3",
    },
  },
};

const ACTIVE_TAB = 7;
// Whether the shortcut finds selected text on the page.
let pageSelection = "";
let onCommand = async (_command: string): Promise<void> => {
  throw new Error("background did not register a command listener");
};
const toPopup: BackgroundErrorEvent[] = [];
const toTab = vi.fn(async (_tabId: number, _envelope: unknown) => undefined);

// Wired once, NO fakeBrowser.reset(): a reset would detach the background's message listener (and the popup recorder) with no way to re-register them.
beforeAll(() => {
  Object.assign(fakeBrowser, {
    contextMenus: {
      removeAll: vi.fn(async () => {}),
      create: vi.fn(),
      onClicked: { addListener: vi.fn() },
    },
    commands: {
      onCommand: {
        addListener: (listener: typeof onCommand) => {
          onCommand = listener;
        },
      },
    },
    downloads: { download: vi.fn(async () => 1) },
    scripting: { executeScript: vi.fn(async () => [{ result: pageSelection }]) },
  });
  Object.assign(fakeBrowser.tabs, {
    query: vi.fn(async () => [{ id: ACTIVE_TAB }]),
    sendMessage: toTab,
  });
  // The browser's own message lookup answers in the browser's language; a toast label taken from it instead of the chosen locale would read so.
  fakeBrowser.i18n.getMessage = vi.fn((key: string) => `browser:${key}`);
  fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
    const envelope = message as { to?: string; id?: string; payload?: BackgroundErrorEvent };
    if (envelope.to === "popup" && envelope.id === "backgroundError" && envelope.payload) {
      toPopup.push(envelope.payload);
    }
  });
  background.main();
});

beforeEach(async () => {
  toPopup.splice(0);
  toTab.mockClear();
  fakeProvider.synthesize.mockClear();
  pageSelection = "";
  await voiceIssuesItem.removeValue();
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

function send(id: string, payload?: unknown): Promise<unknown> {
  return fakeBrowser.runtime.sendMessage({ to: "background", id, payload });
}

/** The banner and the toast get the same notice.
 *    popup event alone  -> also providerId, for the bug report
 *    toast payload alone -> its control labels, from the extension's i18n runtime (the chosen display language), never the browser's */
async function surfaced(): Promise<BackgroundErrorEvent> {
  await vi.waitFor(() => {
    expect(toPopup).toHaveLength(1);
  });
  const [event] = toPopup;
  const { providerId: _provider, ...payload } = event ?? {};
  expect(toTab).toHaveBeenCalledExactlyOnceWith(ACTIVE_TAB, {
    to: "content",
    id: "setError",
    payload: { ...payload, labels: { details: "errors.details", dismiss: "common.dismiss" } },
  });
  return event as BackgroundErrorEvent;
}

// A fetch that never got an answer names no provider of its own, so only the call site's context can name the service and title the notice for what the user asked.
//   context given -> errors.unreachable_message[<provider name>]
//   none          -> the nameless errors.unreachable_service_message
const unreachable = (title: string, providerId: ProviderId): BackgroundErrorEvent => ({
  title,
  message: `errors.unreachable_message[${PROVIDER_NAMES[providerId]}|]`,
  detail: "TypeError: Failed to fetch",
  providerId,
});

describe("background failure notices", () => {
  it("a preview whose request never got an answer is titled as a preview and names the previewed voice's provider, not the selected one", async () => {
    expect(
      await send("previewVoice", {
        providerId: "google",
        voiceId: "Unreachable",
        model: "neural2",
        language: "en-US",
      }),
    ).toEqual({ ok: true, value: false });

    expect(await surfaced()).toEqual(unreachable("errors.preview_failed_title", "google"));
  });

  it("a download whose request never got an answer is titled as a download and names the selected voice's provider", async () => {
    expect(await send("download", { text: "unreachable text" })).toEqual({
      ok: true,
      value: false,
    });

    expect(await surfaced()).toEqual(unreachable("errors.download_failed_title", "polly"));
    expect(fakeBrowser.downloads.download).not.toHaveBeenCalled();
  });

  it("a read whose request never got an answer is titled as a read and names the selected voice's provider", async () => {
    expect(await send("readAloud", { text: "unreachable text" })).toEqual({
      ok: true,
      value: true,
    });

    expect(await surfaced()).toEqual(unreachable("errors.read_failed_title", "polly"));
  });

  it("a Save & test whose settings read rejects before validation is titled as a check, like the inline verdict, not as a read", async () => {
    // The browser's storage refusing the read, as it does when the area is unavailable; the settings load in validateProvider is the first read.
    const get = vi
      .spyOn(fakeBrowser.storage.local, "get")
      .mockRejectedValue(new Error("Access to storage is not allowed from this context"));
    try {
      expect(await send("validateProvider", { providerId: "polly" })).toEqual({
        ok: false,
        error: "Error: Access to storage is not allowed from this context",
      });

      expect(await surfaced()).toEqual({
        title: "settings.validation_unknown_title",
        message: "errors.unknown_message[|]",
        detail: "Error: Access to storage is not allowed from this context",
      });
    } finally {
      get.mockRestore();
    }
  });

  it("a read whose failure quotes the configured key reaches the user with the key blanked", async () => {
    expect(await send("readAloud", { text: "please echo the key" })).toEqual({
      ok: true,
      value: true,
    });

    const notice = {
      title: "errors.read_failed_title",
      message: "errors.unknown_message[Amazon Polly|]",
      detail: "Error: Rejected credential [redacted]",
    };
    expect(await surfaced()).toEqual({ ...notice, providerId: "polly" });
    // The voice is marked with the notice as shown, key blanked included: the picker reads the mark back as it is (the provider is the row's own).
    const selected = { providerId: "polly", voiceId: "Joanna", model: "neural" } as const;
    expect(voiceIssue(await readVoiceIssues(), selected)).toEqual(notice);
  });

  it("a preview whose failure quotes the configured key marks the row with the blanked notice", async () => {
    const echo = { providerId: "polly", voiceId: "Echo", model: "neural" } as const;
    expect(await send("previewVoice", { ...echo, language: "en-US" })).toEqual({
      ok: true,
      value: false,
    });

    const notice = {
      title: "errors.preview_failed_title",
      message: "errors.unknown_message[Amazon Polly|]",
      detail: "Error: Rejected credential [redacted]",
    };
    expect(await surfaced()).toEqual({ ...notice, providerId: "polly" });
    expect(voiceIssue(await readVoiceIssues(), echo)).toEqual(notice);
  });

  it.each([
    { command: "readAloudShortcut", title: "errors.read_failed_title" },
    { command: "downloadShortcut", title: "errors.download_failed_title" },
  ])(
    "$command with nothing selected tells the user to select text, titled for the shortcut, with what the background saw as the detail",
    async ({ command, title }) => {
      await onCommand(command);

      expect(await surfaced()).toEqual({
        title,
        message: "errors.no_selection",
        detail: "NoSelection: retrieveSelection() returned no text after trim",
      });
      expect(fakeProvider.synthesize).not.toHaveBeenCalled();
    },
  );
});
