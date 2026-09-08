import { type BrowserContext, expect, type Page, test, type Worker } from "@playwright/test";
import { textDigest } from "../src/lib/digest";
import type { Playback } from "../src/lib/playback";
import { silentMp3 } from "./fake-provider/mp3";
import { speechSince } from "./fake-provider/requests";
import {
  DEFAULT_AUDIO_SECONDS,
  type FakeSpeechServer,
  startFakeSpeechServer,
} from "./fake-provider/server";
import { type ExtensionSession, launchExtension } from "./fixtures";
import { playingWithSound } from "./playback-waits";
import { relaunchExtension } from "./relaunch";

// Installing this build over a profile an earlier build left behind: when the
// popup opens, the user's voice, engine, style, formats, favorites and keys
// must all be there, and a read must play with them. One profile is seeded
// per shape the extension converts at startup: the flat sync keys the
// single-provider forks wrote, and the first versioned settings object. A
// third profile holds a versioned object with corrupt entries, which must
// cost only those entries. The cloud providers are answered from this
// process, so no key ever reaches AWS or Azure and the runs need none.

// Playwright reports and routes a service worker's own requests only behind
// this flag; the extension's background is one. It must be set before the
// browser launches (module load precedes beforeAll) and adds observability
// only.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

/** Chromium resolves no host but loopback: a provider call this suite does
 *  not answer fails at DNS instead of reaching a real cloud with the seeded
 *  keys. Routed requests never resolve a host, so the stubs are unaffected. */
const OFFLINE = { args: ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] };

/** The Sandbox's initial text; two sentences, so a read synthesizes two chunks. */
const SANDBOX_TEXT = "Hello! This text will be read aloud by the selected voice.";
const CHUNKS = 2;

test.describe.configure({ mode: "serial" });

let server: FakeSpeechServer;

test.beforeAll(async () => {
  server = await startFakeSpeechServer();
});

test.afterAll(async () => {
  await server?.close();
});

// --- The extension's storage, from its background ------------------------------------

/** The extension API as the browser-side callbacks below see it, only the
 *  parts they touch. */
declare const chrome: {
  storage: {
    sync: {
      get(key: null): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
      clear(): Promise<void>;
    };
    local: { clear(): Promise<void> };
    session: { get(key: string): Promise<Record<string, unknown>> };
  };
};

async function background(extension: ExtensionSession): Promise<Worker> {
  const [worker] = extension.context.serviceWorkers();
  return worker ?? (await extension.context.waitForEvent("serviceworker"));
}

/** Everything in the sync area, as stored. */
async function syncArea(extension: ExtensionSession): Promise<Record<string, unknown>> {
  const worker = await background(extension);
  return worker.evaluate(() => chrome.storage.sync.get(null));
}

/** The playback document, as the background last wrote it. */
async function playback(extension: ExtensionSession): Promise<Playback> {
  const worker = await background(extension);
  const stored = await worker.evaluate(() => chrome.storage.session.get("playback"));
  return (stored.playback as Playback | undefined) ?? { status: "idle", epoch: 0, rate: 1 };
}

/** The Web Lock every settings write in the extension queues on (`enqueueWrite`
 *  in lib/storage.ts). Held for the rest of the seeding session, so the
 *  background's watchers cannot write the seed back in its current shape
 *  before the relaunch: the relaunched build must be the first to touch it. */
const SETTINGS_WRITE_LOCK = "cloud-speech-settings-write";

/**
 * A profile as an earlier build's install left it: launch a fresh profile,
 * wait for this build's first-run write (so none of its own state lands after
 * the seed), replace both storage areas with the seed, and start the browser
 * again on that profile with the network closed. The extension's startup then
 * runs against the seed exactly once, as it does after an update, and this
 * returns once its voice fetch has run. Also returns the schema version this
 * build stamps on a fresh install, read from that first-run write.
 *
 * The cloud stubs are installed by the caller, after this: the startup fetch
 * thus fails at DNS in every run rather than racing their installation, and
 * the popup's own refresh is the fetch that meets them. A failed startup fetch
 * leaves the selection alone by design (an empty cache reconciles nothing);
 * one provider succeeding while another fails would not, so no seed here
 * enables a provider the stubs do not answer.
 */
async function installOver(
  profilePrefix: string,
  seed: Record<string, unknown>,
): Promise<{ extension: ExtensionSession; freshVersion: number }> {
  const fresh = await launchExtension(profilePrefix);
  let freshVersion: number;
  try {
    const worker = await background(fresh);
    let firstRun: unknown;
    await expect
      .poll(
        async () => {
          firstRun = (await worker.evaluate(() => chrome.storage.sync.get(null))).settings;
          return firstRun;
        },
        { message: "the fresh install wrote its settings object" },
      )
      .toBeTruthy();
    freshVersion = (firstRun as { schemaVersion: number }).schemaVersion;

    await worker.evaluate(
      ([lock, seed]) =>
        new Promise<void>((seeded, failed) => {
          void navigator.locks.request(lock, async () => {
            try {
              await chrome.storage.sync.clear();
              await chrome.storage.local.clear();
              await chrome.storage.sync.set(seed);
              seeded();
            } catch (error) {
              failed(error);
            }
            // Never released: the browser closes while the lock is held.
            await new Promise(() => {});
          });
        }),
      [SETTINGS_WRITE_LOCK, seed] as const,
    );
    expect(await worker.evaluate(() => chrome.storage.sync.get(null))).toEqual(seed);
  } catch (error) {
    await fresh.close();
    throw error;
  }
  const extension = await relaunchExtension(fresh, OFFLINE);
  try {
    await startupFetchDone(extension);
  } catch (error) {
    await extension.close();
    throw error;
  }
  return { extension, freshVersion };
}

/** The background's startup voice fetch has run: it writes the cache key
 *  whether any provider answered or not. */
async function startupFetchDone(extension: ExtensionSession): Promise<void> {
  const worker = await background(extension);
  await expect
    .poll(
      () => worker.evaluate(async () => "voices" in (await chrome.storage.session.get("voices"))),
      {
        message: "the startup voice fetch has run",
      },
    )
    .toBe(true);
}

// --- The clouds, answered from here ----------------------------------------------------

const audioReply = () => ({
  contentType: "audio/mpeg",
  body: Buffer.from(silentMp3(DEFAULT_AUDIO_SECONDS)),
});

const POLLY_REGION = "us-east-1";
const POLLY_VOICES = [
  {
    Id: "Joanna",
    LanguageCode: "en-US",
    Gender: "Female",
    SupportedEngines: ["neural", "standard"],
  },
  {
    Id: "Vicki",
    LanguageCode: "de-DE",
    Gender: "Female",
    SupportedEngines: ["neural", "standard"],
  },
];

interface PollySynthesis {
  voice: string;
  engine: string;
  format: string;
  /** The access key the request's SigV4 signature names. */
  accessKeyId: string;
  text: string;
}

/** Amazon Polly as the background reaches it: the roster above, and silent
 *  audio for every synthesis, each recorded with the key that signed it. */
async function stubPolly(context: BrowserContext): Promise<{ syntheses: PollySynthesis[] }> {
  const syntheses: PollySynthesis[] = [];
  await context.route(`https://polly.${POLLY_REGION}.amazonaws.com/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/v1/voices") {
      await route.fulfill({ json: { Voices: POLLY_VOICES } });
      return;
    }
    if (request.method() === "POST" && path === "/v1/speech") {
      const body = request.postDataJSON() as Record<string, string>;
      const signature = request.headers().authorization ?? "";
      syntheses.push({
        voice: body.VoiceId ?? "",
        engine: body.Engine ?? "",
        format: body.OutputFormat ?? "",
        accessKeyId: /Credential=([^/]+)\//.exec(signature)?.[1] ?? "",
        text: body.Text ?? "",
      });
      await route.fulfill(audioReply());
      return;
    }
    await route.fulfill({ status: 404, body: `no Polly stub for ${request.method()} ${path}` });
  });
  return { syntheses };
}

const AZURE_REGION = "eastus";
const AZURE_VOICES = [
  {
    ShortName: "en-US-JennyNeural",
    LocalName: "Jenny",
    Locale: "en-US",
    Gender: "Female",
    VoiceType: "Neural",
    StyleList: ["cheerful", "sad"],
  },
  {
    ShortName: "de-DE-KatjaNeural",
    LocalName: "Katja",
    Locale: "de-DE",
    Gender: "Female",
    VoiceType: "Neural",
  },
];

interface AzureSynthesis {
  subscriptionKey: string;
  outputFormat: string;
  ssml: string;
}

/** Azure Speech as the background reaches it: the roster above, and silent
 *  audio for every synthesis, each recorded with its key and SSML. */
async function stubAzure(context: BrowserContext): Promise<{ syntheses: AzureSynthesis[] }> {
  const syntheses: AzureSynthesis[] = [];
  await context.route(`https://${AZURE_REGION}.tts.speech.microsoft.com/**`, async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (request.method() === "GET" && path === "/cognitiveservices/voices/list") {
      await route.fulfill({ json: AZURE_VOICES });
      return;
    }
    if (request.method() === "POST" && path === "/cognitiveservices/v1") {
      const headers = request.headers();
      syntheses.push({
        subscriptionKey: headers["ocp-apim-subscription-key"] ?? "",
        outputFormat: headers["x-microsoft-outputformat"] ?? "",
        ssml: request.postData() ?? "",
      });
      await route.fulfill(audioReply());
      return;
    }
    await route.fulfill({ status: 404, body: `no Azure stub for ${request.method()} ${path}` });
  });
  return { syntheses };
}

// --- Popup ---------------------------------------------------------------------------------

async function openPopup(
  extension: ExtensionSession,
  view?: "Preferences" | "Settings",
): Promise<Page> {
  const page = await extension.openPopup();
  if (view) await page.getByRole("link", { name: view }).click();
  return page;
}

/** The control under a floating label: Preferences renders each select and
 *  the voice picker as a label span beside its control, with no ARIA link
 *  between them. The picker's first button is its trigger. */
function labeled(page: Page, label: string, role: "combobox" | "button") {
  return page
    .locator("span", { hasText: new RegExp(`^${label}$`) })
    .locator("..")
    .getByRole(role)
    .first();
}

function playButton(page: Page) {
  return page.getByRole("button", { name: /^(Play|Pause)$/ });
}

/** Open the voice picker with the language filter off and its favorites chip
 *  pressed (the chip filters within the chosen language), and return the
 *  picker's dialog. */
async function openFavoritesPicker(page: Page) {
  await labeled(page, "Voice language", "combobox").click();
  await page.getByRole("option", { name: "All" }).click();
  await labeled(page, "Voice", "button").click();
  const picker = page.getByRole("dialog");
  await picker.getByRole("button", { name: /Favorites/ }).click();
  return picker;
}

/** A provider row in Settings shows `status`, and once expanded holds the
 *  stored credentials in its fields (a stored key is never asked for again). */
async function expectProviderRow(
  page: Page,
  provider: { id: string; label: string },
  status: "Connected" | "Off",
  fields: Record<string, string>,
) {
  const row = page.getByTestId(`provider-${provider.id}`);
  await expect(row.getByText(status, { exact: true })).toBeVisible();
  await row.getByText(provider.label, { exact: true }).click();
  for (const [label, value] of Object.entries(fields)) {
    await expect(row.getByLabel(label)).toHaveValue(value);
  }
}

/** The Sandbox's read plays its text through the background. */
async function readSandboxText(extension: ExtensionSession) {
  const page = await openPopup(extension);
  await expect(page.locator("textarea")).toHaveValue(SANDBOX_TEXT);
  await playButton(page).click();
  const playing = await playingWithSound(() => playback(extension));
  expect(playing.textDigest).toBe(textDigest(SANDBOX_TEXT));
  await expect(playButton(page)).toHaveAttribute("title", "Pause");
  await page.close();
}

// --- The Polly fork's flat sync keys -------------------------------------------------------

const FORK_KEYS = {
  accessKeyId: "AKIAFORKUSER",
  secretAccessKey: "fork-secret",
  region: POLLY_REGION,
  credentialsValid: true,
  language: "en-US",
  voices: { "en-US": "Joanna", "de-DE": "Vicki" },
  // Not the engine the conversion would assume for a fork user who never
  // chose one, so a dropped choice is visible.
  engine: "standard",
  speed: 1.5,
  pitch: 0,
  // Both differ from the provider's defaults, so their survival is visible.
  readAloudEncoding: "MP3",
  downloadEncoding: "MP3",
};

test.describe("over the Polly fork's flat sync keys", () => {
  let extension: ExtensionSession;
  let freshVersion: number;
  let polly: { syntheses: PollySynthesis[] };

  test.beforeAll(async () => {
    ({ extension, freshVersion } = await installOver("cloud-speech-v1-flat-e2e-", FORK_KEYS));
    polly = await stubPolly(extension.context);
  });

  test.afterAll(async () => {
    await extension?.close();
  });

  test("the sync area holds one current settings object and no flat key", async () => {
    await expect
      .poll(() => syncArea(extension), { message: "the flat keys became the settings object" })
      .toMatchObject({ settings: { schemaVersion: freshVersion } });
    const raw = await syncArea(extension);
    expect(Object.keys(raw)).toEqual(["settings"]);
    expect(raw.settings).toMatchObject({
      perProvider: {
        polly: {
          credentials: {
            accessKeyId: FORK_KEYS.accessKeyId,
            secretAccessKey: FORK_KEYS.secretAccessKey,
            region: POLLY_REGION,
          },
          verified: true,
          enabled: true,
          readAloudEncoding: "MP3",
          downloadEncoding: "MP3",
          lastModel: "standard",
        },
      },
      selection: { providerId: "polly", voiceId: "Joanna", model: "standard" },
      voicesByLanguage: {
        "en-US": { providerId: "polly", voiceId: "Joanna" },
        "de-DE": { providerId: "polly", voiceId: "Vicki" },
      },
      speed: 1.5,
      language: "en-US",
    });
  });

  test("Preferences shows the fork user's voice, engine, speed and formats", async () => {
    const page = await openPopup(extension, "Preferences");
    const voice = labeled(page, "Voice", "button");
    await expect(voice).toContainText("Joanna");
    await expect(voice).toContainText("Standard");
    await expect(voice).toContainText("Amazon Polly");
    await expect(labeled(page, "Voice language", "combobox")).toHaveText("American English (US)");
    await expect(page.getByText("1.5x")).toBeVisible();
    await expect(labeled(page, "Download", "combobox")).toHaveText("MP3");
    await expect(labeled(page, "Read aloud", "combobox")).toHaveText("MP3");
    await page.close();
  });

  test("Settings shows Polly connected with the fork's keys in place", async () => {
    const page = await openPopup(extension, "Settings");
    await expect(page.getByText(/connect a provider to begin/i)).toHaveCount(0);
    await expectProviderRow(page, { id: "polly", label: "Amazon Polly" }, "Connected", {
      "Access Key ID": FORK_KEYS.accessKeyId,
      "Secret Access Key": FORK_KEYS.secretAccessKey,
      Region: POLLY_REGION,
    });
    await page.close();
  });

  test("a read plays through Polly with the fork's voice, engine, speed and key", async () => {
    const before = polly.syntheses.length;
    await readSandboxText(extension);
    const syntheses = polly.syntheses.slice(before);
    expect(
      syntheses.map(({ voice, engine, format, accessKeyId }) => ({
        voice,
        engine,
        format,
        accessKeyId,
      })),
    ).toEqual(
      Array(CHUNKS).fill({
        voice: "Joanna",
        engine: "standard",
        format: "mp3",
        accessKeyId: FORK_KEYS.accessKeyId,
      }),
    );
    for (const { text } of syntheses) expect(text).toContain('rate="150%"');
  });

  test("no popup console errors", () => {
    expect(extension.consoleErrors).toEqual([]);
  });
});

// --- The first versioned settings object ---------------------------------------------------

const AZURE_KEY = "azure-fork-key";
const CUSTOM_KEY = "v1-key";

function versionedSettings(server: FakeSpeechServer) {
  return {
    schemaVersion: 1,
    credentials: {
      azure: { subscriptionKey: AZURE_KEY, region: AZURE_REGION },
      polly: {
        accessKeyId: FORK_KEYS.accessKeyId,
        secretAccessKey: FORK_KEYS.secretAccessKey,
        region: POLLY_REGION,
      },
      custom: { baseUrl: `${server.origin}/v1`, apiKey: CUSTOM_KEY },
    },
    credentialsValid: { azure: true, polly: true, custom: true },
    // Switched off, keys kept: its favorite must stay stored while hidden.
    enabledProviders: { azure: true, polly: true, custom: false },
    selectedVoice: { providerId: "azure", voiceId: "en-US-JennyNeural" },
    voicesByLanguage: {
      "en-US": { providerId: "azure", voiceId: "en-US-JennyNeural" },
      "de-DE": { providerId: "polly", voiceId: "Vicki" },
    },
    favorites: ["azure:en-US-JennyNeural", "custom:beta", "polly:Joanna"],
    model: "neural",
    style: "cheerful",
    speed: 1.25,
    pitch: -2,
    volumeGainDb: 3,
    // Both differ from the provider's defaults, so their survival is visible.
    readAloudEncoding: "MP3",
    downloadEncoding: "MP3",
    language: "en-US",
    theme: "dark",
    uiLanguage: "auto",
  };
}

test.describe("over the first versioned settings object", () => {
  let extension: ExtensionSession;
  let freshVersion: number;
  let azure: { syntheses: AzureSynthesis[] };
  let seed: ReturnType<typeof versionedSettings>;

  test.beforeAll(async () => {
    seed = versionedSettings(server);
    ({ extension, freshVersion } = await installOver("cloud-speech-v1-object-e2e-", {
      settings: seed,
    }));
    await stubPolly(extension.context);
    azure = await stubAzure(extension.context);
  });

  test.afterAll(async () => {
    await extension?.close();
  });

  test("the object is rewritten in the current shape with everything carried", async () => {
    await expect
      .poll(() => syncArea(extension), { message: "the settings object reached the current shape" })
      .toMatchObject({ settings: { schemaVersion: freshVersion } });
    const raw = await syncArea(extension);
    expect(Object.keys(raw)).toEqual(["settings"]);
    expect(raw.settings).toMatchObject({
      perProvider: {
        azure: {
          credentials: seed.credentials.azure,
          verified: true,
          enabled: true,
          readAloudEncoding: "MP3",
          downloadEncoding: "MP3",
          lastModel: "neural",
        },
        polly: { credentials: seed.credentials.polly, verified: true, enabled: true },
        custom: { credentials: seed.credentials.custom, verified: true, enabled: false },
      },
      selection: {
        providerId: "azure",
        voiceId: "en-US-JennyNeural",
        model: "neural",
        style: "cheerful",
      },
      voicesByLanguage: seed.voicesByLanguage,
      favorites: seed.favorites,
      speed: 1.25,
      pitch: -2,
      volumeGainDb: 3,
      language: "en-US",
      theme: "dark",
    });
  });

  test("Preferences shows the voice, style, prosody, formats, theme and favorites", async () => {
    const page = await openPopup(extension, "Preferences");
    const voice = labeled(page, "Voice", "button");
    await expect(voice).toContainText("Jenny");
    await expect(voice).toContainText("Azure Speech");
    await expect(labeled(page, "Voice language", "combobox")).toHaveText("American English (US)");
    await expect(labeled(page, "Speaking style", "combobox")).toHaveText("cheerful");
    await expect(page.getByText("1.25x")).toBeVisible();
    await expect(page.getByText("-2", { exact: true })).toBeVisible();
    await expect(page.getByText("3dB")).toBeVisible();
    await expect(labeled(page, "Download", "combobox")).toHaveText("MP3");
    await expect(labeled(page, "Read aloud", "combobox")).toHaveText("MP3");
    await expect(labeled(page, "Theme", "combobox")).toHaveText("Dark");

    // Under the favorites chip: every favorite of an enabled provider, one
    // row per engine (Joanna offers two), and the switched-off provider's
    // favorite counted as hidden, not gone.
    const picker = await openFavoritesPicker(page);
    for (const name of ["Jenny", "Joanna"]) {
      await expect(
        picker.getByRole("button", { name: new RegExp(`^${name}\\b`) }).first(),
      ).toBeVisible();
    }
    await expect(picker.getByTitle("Favorite")).toHaveCount(3);
    await expect(picker.getByText("1 favorite(s) unavailable", { exact: false })).toBeVisible();
    await page.close();
  });

  test("Settings shows the two connected providers and the switched-off one, keys in place", async () => {
    const page = await openPopup(extension, "Settings");
    await expect(page.getByText(/connect a provider to begin/i)).toHaveCount(0);
    await expectProviderRow(page, { id: "azure", label: "Azure Speech" }, "Connected", {
      "Subscription Key": AZURE_KEY,
      Region: AZURE_REGION,
    });
    await expectProviderRow(page, { id: "polly", label: "Amazon Polly" }, "Connected", {
      "Access Key ID": FORK_KEYS.accessKeyId,
    });
    await expectProviderRow(page, { id: "custom", label: "OpenAI-compatible" }, "Off", {
      "Server URL": `${server.origin}/v1`,
      "API key (optional)": CUSTOM_KEY,
    });
    await page.close();
  });

  test("a read plays through Azure with the voice, style, format and key", async () => {
    const before = azure.syntheses.length;
    await readSandboxText(extension);
    const syntheses = azure.syntheses.slice(before);
    expect(
      syntheses.map(({ subscriptionKey, outputFormat }) => ({ subscriptionKey, outputFormat })),
    ).toEqual(
      Array(CHUNKS).fill({
        subscriptionKey: AZURE_KEY,
        outputFormat: "audio-16khz-32kbitrate-mono-mp3",
      }),
    );
    for (const { ssml } of syntheses) {
      expect(ssml).toContain('<voice name="en-US-JennyNeural">');
      expect(ssml).toContain('style="cheerful"');
    }
  });

  test("no popup console errors", () => {
    expect(extension.consoleErrors).toEqual([]);
  });
});

// --- A versioned object with corrupt entries -----------------------------------------------

test.describe("over a versioned object with a corrupt favorite and an unknown provider", () => {
  let extension: ExtensionSession;
  let freshVersion: number;
  const customCredentials = () => ({ baseUrl: `${server.origin}/v1`, apiKey: CUSTOM_KEY });

  test.beforeAll(async () => {
    ({ extension, freshVersion } = await installOver("cloud-speech-v1-corrupt-e2e-", {
      settings: {
        schemaVersion: 1,
        // A provider id no build ever had, next to a real entry.
        credentials: { custom: customCredentials(), typo: { apiKey: "x" } },
        credentialsValid: { custom: true, typo: true },
        enabledProviders: { custom: true, typo: true },
        selectedVoice: { providerId: "custom", voiceId: "beta" },
        model: "tts-1",
        // A favorite that is not a voice key at all.
        favorites: ["custom:beta", 42],
        speed: 1,
        pitch: 0,
        volumeGainDb: 0,
        readAloudEncoding: "MP3",
        downloadEncoding: "MP3",
        language: "en-US",
        theme: "system",
        uiLanguage: "auto",
      },
    }));
  });

  test.afterAll(async () => {
    await extension?.close();
  });

  test("startup keeps the real provider and the selection; the corrupt entries are gone", async () => {
    await expect
      .poll(() => syncArea(extension), { message: "the settings object reached the current shape" })
      .toMatchObject({ settings: { schemaVersion: freshVersion } });
    const settings = (await syncArea(extension)).settings as {
      perProvider: Record<string, unknown>;
      favorites: unknown;
      selection: unknown;
    };
    expect(Object.keys(settings.perProvider)).toEqual(["custom"]);
    expect(settings.perProvider.custom).toMatchObject({
      credentials: customCredentials(),
      verified: true,
      enabled: true,
      // The remembered engine, which a reconcile against the voice would not
      // restore had the conversion dropped the stored one.
      lastModel: "tts-1",
    });
    expect(settings.selection).toEqual({ providerId: "custom", voiceId: "beta", model: "tts-1" });
    // The favorites list is one value: a corrupt entry costs the list, as the
    // unit tests pin, never the voice or the keys next to it.
    expect(settings.favorites).toEqual([]);
  });

  test("the popup opens on the kept provider and a read plays through it", async () => {
    const page = await openPopup(extension, "Settings");
    await expect(page.getByText(/connect a provider to begin/i)).toHaveCount(0);
    await expectProviderRow(page, { id: "custom", label: "OpenAI-compatible" }, "Connected", {
      "Server URL": `${server.origin}/v1`,
    });
    await page.getByRole("link", { name: "Preferences" }).click();
    await expect(labeled(page, "Voice", "button")).toContainText("beta");
    await page.close();

    const marker = server.mark();
    await readSandboxText(extension);
    expect(
      speechSince(server, marker).map(({ voice, model, authorization, status }) => ({
        voice,
        model,
        authorization,
        status,
      })),
    ).toEqual(
      Array(CHUNKS).fill({
        voice: "beta",
        model: "tts-1",
        authorization: `Bearer ${CUSTOM_KEY}`,
        status: "completed",
      }),
    );
  });

  test("no popup console errors", () => {
    expect(extension.consoleErrors).toEqual([]);
  });
});
