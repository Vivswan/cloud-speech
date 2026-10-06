import { expect, type Page, test } from "@playwright/test";
import type { RouteId } from "../../src/lib/protocol";
import type { Settings } from "../../src/lib/settings/storage";
import { textDigest } from "../../src/lib/text/digest";
import { providerPanel, providerStatus, resumeContinuesFrom, voicePicker } from "./assertions";
import { speechSince, targetsSince } from "./fake-provider/requests";
import {
  DEFAULT_AUDIO_SECONDS,
  type FakeSpeechServer,
  startFakeSpeechServer,
} from "./fake-provider/server";
import { background, type ExtensionSession, launchExtension, readPlayback } from "./fixtures";
import {
  installPopupRecorder,
  type PopupObservations,
  type PopupRecorderOptions,
  readPopupObservations,
} from "./page-recorder";
import { playbackReaches, playingWithSound } from "./playback-waits";
import {
  API_KEY,
  MODEL,
  PICKED,
  registerSharedScenario,
  SANDBOX_TEXT,
  type ScenarioDriver,
} from "./scenarios";

// The whole read pipeline, end to end, against a local OpenAI-compatible server: no provider keys.
// The steps share one browser profile and build on each other in order.

test.describe.configure({ mode: "serial" });

let server: FakeSpeechServer;
let extension: ExtensionSession;

test.beforeAll(async () => {
  server = await startFakeSpeechServer();
  extension = await launchExtension("cloud-speech-fake-provider-e2e-");
});

test.afterAll(async () => {
  try {
    await extension?.close();
  } finally {
    await server?.close();
  }
});

// A step that fails while holding replies must not leave the next one stuck.
test.afterEach(() => {
  server.releaseReplies();
  server.speechStatus = 200;
  server.audioSeconds = DEFAULT_AUDIO_SECONDS;
});

// --- Extension state, read where the background keeps it -----------------------

/** The extension API as the browser-side callbacks below see it, only the
 *  parts they touch. The source itself uses WXT's `browser` and never the
 *  `chrome` global, so nothing else brings its typings in. */
declare const chrome: {
  storage: {
    sync: { get(key: string): Promise<Record<string, unknown>> };
    session: {
      onChanged: {
        addListener(
          listener: (changes: Record<string, { newValue?: unknown } | undefined>) => void,
        ): void;
      };
    };
  };
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

const playback = () => readPlayback(extension);

async function settings(): Promise<Settings> {
  const worker = await background(extension);
  const stored = await worker.evaluate(() => chrome.storage.sync.get("settings"));
  return stored.settings as Settings;
}

/** The popup has no control for a second read or a stop, so those go as the route a control would send; the reply
 *  is the one barrier that says the handler has finished. `sentAt` is the page's clock, comparable with its other stamps. */
function request(
  page: Page,
  id: RouteId<"background">,
  payload?: unknown,
): Promise<{ sentAt: number; reply: unknown }> {
  return page.evaluate(
    async ([id, payload]) => {
      const sentAt = Date.now();
      const reply = await chrome.runtime.sendMessage({ to: "background", id, payload });
      return { sentAt, reply };
    },
    [id, payload] as const,
  );
}

// --- Popup ------------------------------------------------------------------------

const BANNER_TITLE = "Could not read aloud";

async function openPopup(view?: "Preferences" | "Settings"): Promise<Page> {
  const page = await extension.openPopup();
  await page.evaluate(installPopupRecorder, {
    api: "chrome",
    bannerTitle: BANNER_TITLE,
  } satisfies PopupRecorderOptions);
  if (view) await page.getByRole("link", { name: view }).click();
  return page;
}

function observations(page: Page): Promise<PopupObservations> {
  return page.evaluate(readPopupObservations);
}

async function errorBannerSeen(page: Page): Promise<boolean> {
  return (await observations(page)).errorBannerSeen;
}

async function openCustomProviderRow(page: Page) {
  const row = page.getByTestId("provider-custom");
  await row.getByText("OpenAI-compatible", { exact: true }).click();
  return row;
}

function playButton(page: Page) {
  return page.getByRole("button", { name: /^(Play|Pause)$/ });
}

function errorBanner(page: Page) {
  return page.getByText(BANNER_TITLE);
}

function previewButton(page: Page) {
  return page.getByRole("button", { name: "Preview" }).first();
}

const driver = (): ScenarioDriver<Page> => ({
  server,
  openPopup,
  request,
  playback,
  observations,
  errorBannerSeen,
  textareaValue: (page) => page.locator("textarea").inputValue(),
  playButtonTitle: (page) => playButton(page).getAttribute("title"),
  clickPlay: (page) => playButton(page).click(),
  previewPressed: (page) => previewButton(page).getAttribute("aria-pressed"),
  clickPreview: (page) => previewButton(page).click(),
});

// --- Steps -------------------------------------------------------------------------

test("Save & test connects the fake server and a voice can be picked", async () => {
  const marker = server.mark();
  const page = await openPopup("Settings");
  const row = await openCustomProviderRow(page);
  await row.getByLabel("Server URL").fill(`${server.origin}/v1`);
  await row.getByLabel("API key (optional)").fill(API_KEY);
  await row.getByRole("button", { name: "Save & test" }).click();

  await expect(providerStatus(row, "Connected")).toBeVisible();
  await expect(row.getByText("2 voices")).toBeVisible();
  await expect(providerPanel(row).getByText("All 1 engines work with your key")).toBeVisible();

  // Discovery, the validation probe, then the availability scan; both
  // synthesize with the first discovered voice.
  const authorization = `Bearer ${API_KEY}`;
  const probe = {
    kind: "speech",
    voice: "alpha",
    model: MODEL,
    authorization,
    status: "completed",
  };
  expect(
    server.since(marker).map(({ kind, input, voice, model, authorization, status }) => ({
      kind,
      input,
      voice,
      model,
      authorization,
      status,
    })),
  ).toEqual([
    { kind: "voices", input: "", voice: "", model: "", authorization, status: "completed" },
    { ...probe, input: "Hi" },
    { ...probe, input: "." },
  ]);

  await page.getByRole("link", { name: "Preferences" }).click();
  const trigger = voicePicker(page, "alpha");
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole("button", { name: /^beta/ }).click();
  await expect(voicePicker(page, "beta")).toBeVisible();

  // The fake server only speaks MP3, which is the provider's first read-aloud
  // format and so the default the format select resolves to.
  await expect(page.getByRole("combobox").filter({ hasText: "MP3" })).toHaveCount(2);

  await expect
    .poll(async () => {
      const current = await settings();
      return {
        selection: current.selection,
        apiKey: current.perProvider.custom?.credentials.apiKey,
      };
    })
    .toEqual({
      selection: { providerId: "custom", voiceId: PICKED.voice, model: PICKED.model },
      apiKey: API_KEY,
    });
  await page.close();
});

registerSharedScenario("a read goes synthesizing, then playing, and the position advances", driver);

test("a pause survives closing the popup and resume continues from it", async () => {
  const page = await openPopup();
  await expect(playButton(page)).toHaveAttribute("title", "Pause");
  // The pause button sends this same route. Awaiting the reply is what makes
  // the snapshot final: the background publishes "paused" first and writes
  // the element's exact position after the audio host answers.
  expect((await request(page, "playerPause")).reply).toEqual({ ok: true, value: true });
  const paused = await playbackReaches(playback, "paused");
  const parkedAt = paused.currentTime;
  expect(parkedAt).toBeGreaterThan(0);
  await expect(playButton(page)).toHaveAttribute("title", "Play");
  await page.close();

  // The claim under test is that nothing moves while the popup is closed, so
  // the wait itself is the experiment: read back after real time has passed.
  await new Promise((resolve) => setTimeout(resolve, 2000));
  expect(await playback()).toEqual(paused);

  const reopened = await openPopup();
  await expect(playButton(reopened)).toHaveAttribute("title", "Play");
  await expect(reopened.getByRole("slider")).toHaveAttribute("aria-valuenow", String(parkedAt));
  await playButton(reopened).click();

  // An element that kept running through the 2 s wait (a pause that never
  // reached it) writes a position past the resume bound.
  await resumeContinuesFrom(() => observations(reopened), parkedAt);
  await reopened.close();
});

registerSharedScenario("a second read cancels the first one's request at the server", driver);

registerSharedScenario(
  "a stop mid-synthesis settles idle within a second and shows no error",
  driver,
);

test("a refused request settles idle and reaches the popup banner", async () => {
  // Negative control for the no-banner checks: the banner does appear when
  // the provider fails for real (a 400 is not retried).
  const marker = server.mark();
  const text = "A read the server refuses.";
  const page = await openPopup();
  server.speechStatus = 400;

  await request(page, "readAloud", { text });
  await expect(errorBanner(page)).toBeVisible();
  await expect(
    page.getByText(
      "OpenAI-compatible could not read this text with this voice. Try another voice.",
    ),
  ).toBeVisible();
  const detail = page.getByText(/HTTP 400 \(fake server answered 400\)/);
  await expect(detail).toBeHidden();
  await page.getByText("Details", { exact: true }).click();
  await expect(detail).toBeVisible();
  await playbackReaches(playback, "idle");
  expect(speechSince(server, marker).map(({ input, status }) => ({ input, status }))).toEqual([
    { input: text, status: "completed" },
  ]);
  server.speechStatus = 200;

  // The next read replays the sandbox text's cached audio (the earlier step
  // synthesized it with the same settings), so no request goes out; it plays
  // and the banner is gone.
  await playButton(page).click();
  const playing = await playingWithSound(playback);
  expect(playing.textDigest).toBe(textDigest(SANDBOX_TEXT));
  await expect(errorBanner(page)).toHaveCount(0);
  expect(await errorBannerSeen(page)).toBe(true);
  expect(speechSince(server, marker).map(({ input, status }) => ({ input, status }))).toEqual([
    { input: text, status: "completed" },
  ]);
  await page.close();
});

// The popup reads the page's selection through scripting.executeScript, which
// only the <all_urls> host permission authorizes: no other manifest entry
// grants page access.
const ARTICLE_URL = "http://selection.test/article";
const SELECTED_TEXT = "The words highlighted on the page are what gets read.";

test("the page selection reaches the popup through the host permission and plays", async () => {
  const marker = server.mark();
  // The popup first: the article opened next becomes the active tab, the one
  // the mounting Sandbox looks at.
  const popup = await extension.openPopup();
  const article = await extension.context.newPage();
  await article.route(ARTICLE_URL, (route) =>
    route.fulfill({ contentType: "text/html", body: `<p id="quote">${SELECTED_TEXT}</p>` }),
  );
  await article.goto(ARTICLE_URL);
  await article.evaluate(() => {
    const quote = document.getElementById("quote");
    if (!quote) throw new Error("the quote paragraph is missing");
    window.getSelection()?.selectAllChildren(quote);
  });
  await popup.reload();

  await expect(popup.getByText(`Selected on page: "${SELECTED_TEXT}"`)).toBeVisible();
  await popup.getByRole("button", { name: "Use selection" }).click();
  await expect(popup.locator("textarea")).toHaveValue(SELECTED_TEXT);
  // The previous step's read is still playing, and the button would pause it.
  await request(popup, "stopReading");
  await playbackReaches(playback, "idle");
  await expect(playButton(popup)).toHaveAttribute("title", "Play");
  await playButton(popup).click();

  const playing = await playingWithSound(playback);
  expect(playing.textDigest).toBe(textDigest(SELECTED_TEXT));
  expect(speechSince(server, marker).map(({ input, status }) => ({ input, status }))).toEqual([
    { input: SELECTED_TEXT, status: "completed" },
  ]);
  expect(targetsSince(server, marker)).toEqual([PICKED]);
  await article.close();
  await popup.close();
});

registerSharedScenario(
  "two quick preview presses cancel one preview and leave the row unpressed",
  driver,
);

test("two fast Save & tests with different keys store only the second key", async () => {
  const olderKey = "fake-key-two";
  const newerKey = "fake-key-three";

  // Each popup holds its own draft; the newer Save & test cancels the older one's provider call and alone may persist.
  const older = await openPopup("Settings");
  const olderRow = await openCustomProviderRow(older);
  await olderRow.getByLabel("API key (optional)").fill(olderKey);
  const newer = await openPopup("Settings");
  const newerRow = await openCustomProviderRow(newer);
  await newerRow.getByLabel("API key (optional)").fill(newerKey);

  const marker = server.mark();
  const byKey = (key: string) =>
    server
      .since(marker)
      .filter((r) => r.authorization === `Bearer ${key}`)
      .map(({ kind, input, status }) => ({ kind, input, status }));
  server.holdReplies();
  await olderRow.getByRole("button", { name: "Save & test" }).click();
  await expect
    .poll(() => byKey(olderKey))
    .toEqual([{ kind: "voices", input: "", status: "pending" }]);
  await newerRow.getByRole("button", { name: "Save & test" }).click();
  await expect
    .poll(() => byKey(olderKey))
    .toEqual([{ kind: "voices", input: "", status: "aborted" }]);
  server.releaseReplies();

  await expect(providerPanel(newerRow).getByText("All 1 engines work with your key")).toBeVisible({
    timeout: 20_000,
  });
  // The superseded popup shows no verdict of its own: the newer Save & test's
  // outcome is the one that counts. Its button is back at rest, no error.
  await expect(olderRow.getByRole("button", { name: "Save & test" })).toBeEnabled();
  await expect(olderRow.getByText(/credentials|rejected|failed/)).toHaveCount(0);

  expect((await settings()).perProvider.custom?.credentials.apiKey).toBe(newerKey);
  // The older draft was cut off at discovery and never probed or scanned;
  // the newer one ran the whole Save & test.
  expect(byKey(olderKey)).toEqual([{ kind: "voices", input: "", status: "aborted" }]);
  expect(byKey(newerKey)).toEqual(
    expect.arrayContaining([
      { kind: "voices", input: "", status: "completed" },
      { kind: "speech", input: "Hi", status: "completed" },
      { kind: "speech", input: ".", status: "completed" },
    ]),
  );
  expect(byKey(newerKey).filter((r) => r.status !== "completed")).toEqual([]);
  await older.close();
  await newer.close();
});

test("no popup console errors across the flow", () => {
  expect(extension.consoleErrors).toEqual([]);
});
