import { expect, type Page, test } from "@playwright/test";
import { textDigest } from "../src/lib/digest";
import type { Playback } from "../src/lib/playback";
import type { RouteId } from "../src/lib/protocol";
import type { Settings } from "../src/lib/storage";
import {
  DEFAULT_AUDIO_SECONDS,
  type FakeSpeechServer,
  startFakeSpeechServer,
} from "./fake-provider/server";
import { type ExtensionSession, launchExtension } from "./fixtures";

// The whole read pipeline, end to end, against a local OpenAI-compatible
// server: Save & test, voice selection, a read that synthesizes and plays,
// pause/resume across a popup close, supersession and stop while a request
// is in flight, preview toggling, and racing Save & tests. No provider keys.
// The steps share one browser profile and build on each other in order.

const SANDBOX_TEXT = "Hello! This text will be read aloud by the selected voice.";
// The provider chunks per sentence and stitches the replies; two concurrent
// chunk requests reach the server in either order.
const SANDBOX_CHUNKS = ["Hello!", "This text will be read aloud by the selected voice."];
const PREVIEW_CHUNKS = ["Hello!", "This is how I sound."];
const FIRST_KEY = "fake-key-one";
// The provider's model when the model field is left empty; the first step
// picks the voice by hand, and every later synthesis must ask for that pair.
const MODEL = "tts-1";
const PICKED = { voice: "beta", model: MODEL };

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
      get(key: string): Promise<Record<string, unknown>>;
      onChanged: {
        addListener(
          listener: (changes: Record<string, { newValue?: unknown } | undefined>) => void,
        ): void;
      };
    };
  };
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

async function background() {
  const [worker] = extension.context.serviceWorkers();
  return worker ?? (await extension.context.waitForEvent("serviceworker"));
}

/** The playback document (storage.session), as the background last wrote it. */
async function playback(): Promise<Playback> {
  const worker = await background();
  const stored = await worker.evaluate(() => chrome.storage.session.get("playback"));
  return (stored.playback as Playback | undefined) ?? { status: "idle", epoch: 0, rate: 1 };
}

async function settings(): Promise<Settings> {
  const worker = await background();
  const stored = await worker.evaluate(() => chrome.storage.sync.get("settings"));
  return stored.settings as Settings;
}

/** A background request sent from the popup's own context and awaited to its
 *  reply. The context menu and keyboard shortcut reach the background this
 *  way for what the popup has no control for (a second read, a stop), and
 *  the reply is the one barrier that says the handler has finished. `sentAt`
 *  is the page's Date.now() right before the send, comparable with the
 *  page's other stamps. */
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

type PlaybackAt<S extends Playback["status"]> = Extract<Playback, { status: S }>;

/** Wait until the document reaches `status` (and `where`, when given) and
 *  return the document that did; a later re-read could already have moved on. */
async function playbackReaches<S extends Playback["status"]>(
  status: S,
  options: { where?: (doc: PlaybackAt<S>) => boolean; timeout?: number } = {},
): Promise<PlaybackAt<S>> {
  let matched: PlaybackAt<S> | undefined;
  await expect
    .poll(
      async () => {
        const doc = await playback();
        if (doc.status === status) {
          const narrowed = doc as PlaybackAt<S>;
          if (options.where?.(narrowed) ?? true) matched = narrowed;
        }
        return matched !== undefined;
      },
      {
        message: `playback reaches ${status}`,
        timeout: options.timeout ?? 15_000,
        intervals: [100],
      },
    )
    .toBe(true);
  if (!matched) throw new Error(`playback never reached ${status}`);
  return matched;
}

/** A read that is audibly under way: playing, past position zero. */
function playingWithSound(): Promise<PlaybackAt<"playing">> {
  return playbackReaches("playing", { where: (doc) => doc.currentTime > 0 });
}

/** Synthesis requests since the marker. Voice discovery is left out: every
 *  popup mount refreshes the voice list. */
function speechSince(marker: number) {
  return server.since(marker).filter((r) => r.kind === "speech");
}

function statusesSince(marker: number): string[] {
  return speechSince(marker).map((r) => r.status);
}

/** The synthesis inputs since the marker, order-insensitive (see SANDBOX_CHUNKS). */
function inputsSince(marker: number): string[] {
  return speechSince(marker)
    .map((r) => r.input)
    .sort();
}

/** The voice and model each synthesis request since the marker asked for. */
function targetsSince(marker: number): Array<{ voice: string; model: string }> {
  return speechSince(marker).map(({ voice, model }) => ({ voice, model }));
}

/** Wait until the server holds exactly `count` synthesis requests since the
 *  marker, none answered: the point at which a cancellation is observable. */
async function pendingSpeech(marker: number, count: number): Promise<void> {
  await expect
    .poll(() => statusesSince(marker), { message: `${count} synthesis requests in flight` })
    .toEqual(Array<string>(count).fill("pending"));
}

// --- Popup ------------------------------------------------------------------------

const BANNER_TITLE = "Speech synthesis failed";

/** What a popup page records about itself from the moment it loads, each
 *  entry stamped with the page's own Date.now(). Kept in the page, not read
 *  by polling from here, so no transition is missed and no measurement
 *  depends on how late this process gets to look. */
interface PopupObservations {
  /** The error banner has been shown at least once. Starting a read or a
   *  preview from the popup clears the banner first, so a snapshot after the
   *  recovery action would miss one that a cancellation wrongly raised. */
  errorBannerSeen: boolean;
  /** Every playback document written while the page was open, in order. */
  playbackHistory: Array<{ at: number; doc: Playback }>;
  /** Every change of an audition row's pressed state, in order. */
  previewFlips: Array<{ at: number; pressed: boolean }>;
}

async function openPopup(view?: "Preferences" | "Settings"): Promise<Page> {
  const page = await extension.openPopup();
  await page.evaluate((title) => {
    const shown = () => document.body.innerText.includes(title);
    const observed: PopupObservations = {
      errorBannerSeen: shown(),
      playbackHistory: [],
      previewFlips: [],
    };
    (globalThis as { observed?: PopupObservations }).observed = observed;
    new MutationObserver((mutations) => {
      if (shown()) observed.errorBannerSeen = true;
      for (const mutation of mutations) {
        if (mutation.type !== "attributes" || mutation.oldValue === null) continue;
        const pressed = (mutation.target as Element).getAttribute("aria-pressed") === "true";
        if (pressed !== (mutation.oldValue === "true")) {
          observed.previewFlips.push({ at: Date.now(), pressed });
        }
      }
    }).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-pressed"],
      attributeOldValue: true,
    });
    chrome.storage.session.onChanged.addListener((changes) => {
      const next = changes.playback?.newValue;
      if (next) observed.playbackHistory.push({ at: Date.now(), doc: next as Playback });
    });
  }, BANNER_TITLE);
  if (view) await page.getByRole("link", { name: view }).click();
  return page;
}

function observations(page: Page): Promise<PopupObservations> {
  return page.evaluate(() => {
    const observed = (globalThis as { observed?: PopupObservations }).observed;
    if (!observed) throw new Error("popup observations were never installed");
    return observed;
  });
}

async function errorBannerSeen(page: Page): Promise<boolean> {
  return (await observations(page)).errorBannerSeen;
}

/** Wait until the page's playback history holds an entry `where` accepts and
 *  return that history snapshot, so what is asserted is what was polled. */
async function historyReaches(
  page: Page,
  where: (entry: PopupObservations["playbackHistory"][number]) => boolean,
): Promise<PopupObservations["playbackHistory"]> {
  let snapshot: PopupObservations["playbackHistory"] = [];
  await expect
    .poll(
      async () => {
        snapshot = (await observations(page)).playbackHistory;
        return snapshot.some(where);
      },
      { message: "popup playback history reaches the expected entry", intervals: [100] },
    )
    .toBe(true);
  return snapshot;
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

// --- Steps -------------------------------------------------------------------------

test("Save & test connects the fake server and a voice can be picked", async () => {
  const marker = server.mark();
  const page = await openPopup("Settings");
  const row = await openCustomProviderRow(page);
  await row.getByLabel("Server URL").fill(`${server.origin}/v1`);
  await row.getByLabel("API key (optional)").fill(FIRST_KEY);
  await row.getByRole("button", { name: "Save & test" }).click();

  await expect(row.getByText("Connected", { exact: true })).toBeVisible();
  await expect(row.getByText("2 voices")).toBeVisible();
  await expect(row.getByText("All 1 engines work with your key")).toBeVisible();

  // Discovery, the validation probe, then the availability scan; both
  // synthesize with the first discovered voice.
  const authorization = `Bearer ${FIRST_KEY}`;
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

  // The first voice was picked automatically; pick the other one by hand.
  await page.getByRole("link", { name: "Preferences" }).click();
  const trigger = page.getByRole("button", { name: /^alpha/ });
  await expect(trigger).toBeVisible();
  await trigger.click();
  await page.getByRole("button", { name: /^beta/ }).click();
  await expect(page.getByRole("button", { name: /^beta/ })).toBeVisible();

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
      apiKey: FIRST_KEY,
    });
  await page.close();
});

test("a read goes synthesizing, then playing, and the position advances", async () => {
  const marker = server.mark();
  const page = await openPopup();
  await expect(page.locator("textarea")).toHaveValue(SANDBOX_TEXT);
  server.holdReplies();
  await playButton(page).click();

  await playbackReaches("synthesizing");
  await pendingSpeech(marker, SANDBOX_CHUNKS.length);
  server.releaseReplies();

  const playing = await playingWithSound();
  expect(playing.textDigest).toBe(textDigest(SANDBOX_TEXT));
  await expect(playButton(page)).toHaveAttribute("title", "Pause");

  // Both chunks stitched: the timeline spans more than one reply's audio.
  const later = await playbackReaches("playing", {
    where: (doc) => doc.currentTime > 1 && doc.duration > server.audioSeconds * 1.5,
  });
  expect(later.currentTime).toBeGreaterThan(1);

  // Every chunk asked for the picked voice and model, as mp3, with the key.
  expect(inputsSince(marker)).toEqual([...SANDBOX_CHUNKS].sort());
  expect(
    speechSince(marker).map(({ voice, model, responseFormat, authorization, status }) => ({
      voice,
      model,
      responseFormat,
      authorization,
      status,
    })),
  ).toEqual(
    SANDBOX_CHUNKS.map(() => ({
      ...PICKED,
      responseFormat: "mp3",
      authorization: `Bearer ${FIRST_KEY}`,
      status: "completed",
    })),
  );
  await page.close();
});

test("a pause survives closing the popup and resume continues from it", async () => {
  const page = await openPopup();
  await expect(playButton(page)).toHaveAttribute("title", "Pause");
  // The pause button sends this same route. Awaiting the reply is what makes
  // the snapshot final: the background publishes "paused" first and writes
  // the element's exact position after the audio host answers.
  expect((await request(page, "playerPause")).reply).toEqual({ ok: true, value: true });
  const paused = await playbackReaches("paused");
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

  // The positions the element reports after the resume are the evidence, read
  // from the page's own stamped record of every document written. The resume
  // itself writes the parked position; every later tick may exceed it by at
  // most the page time elapsed since that write. A resume from 0 writes
  // smaller positions; an element that kept running through the 2 s wait (a
  // pause that never reached it) writes one past the bound. Nothing here
  // depends on when this process looks.
  const history = await historyReaches(
    reopened,
    (entry) => entry.doc.status === "playing" && entry.doc.currentTime > parkedAt,
  );
  const playing = history.flatMap((entry) =>
    entry.doc.status === "playing" ? [{ at: entry.at, position: entry.doc.currentTime }] : [],
  );
  const [resumed, ...ticks] = playing;
  expect(resumed?.position).toBe(parkedAt);
  expect(ticks.length).toBeGreaterThan(0);
  for (const tick of ticks) {
    expect(tick.position).toBeGreaterThanOrEqual(parkedAt);
    expect(tick.position - parkedAt).toBeLessThanOrEqual((tick.at - resumed!.at) / 1000 + 0.25);
  }
  await reopened.close();
});

test("a second read cancels the first one's request at the server", async () => {
  const marker = server.mark();
  const first = "The first read, superseded while its request is still open.";
  const second = "The second read, which is the one that plays.";
  const page = await openPopup();
  server.holdReplies();

  await request(page, "readAloud", { text: first });
  await pendingSpeech(marker, 1);
  await request(page, "readAloud", { text: second });

  await expect
    .poll(() => speechSince(marker).map(({ input, status }) => ({ input, status })), {
      message: "the fake server saw the first request's connection close",
    })
    .toEqual([
      { input: first, status: "aborted" },
      { input: second, status: "pending" },
    ]);
  server.releaseReplies();

  const playing = await playingWithSound();
  expect(playing.textDigest).toBe(textDigest(second));
  expect(speechSince(marker).map(({ input, status }) => ({ input, status }))).toEqual([
    { input: first, status: "aborted" },
    { input: second, status: "completed" },
  ]);
  expect(targetsSince(marker)).toEqual([PICKED, PICKED]);
  await page.close();
});

test("a stop mid-synthesis settles idle within a second and shows no error", async () => {
  const marker = server.mark();
  const text = "A read that is stopped before its request completes.";
  const page = await openPopup();
  server.holdReplies();

  await request(page, "readAloud", { text });
  await pendingSpeech(marker, 1);
  // Timed on the page's clock: from the stop being sent to the idle document
  // landing, as the page's history recorded it.
  const { sentAt } = await request(page, "stopReading");
  const history = await historyReaches(
    page,
    (entry) => entry.doc.status === "idle" && entry.at >= sentAt,
  );
  const idle = history.find((entry) => entry.doc.status === "idle" && entry.at >= sentAt);
  expect((idle?.at ?? Number.POSITIVE_INFINITY) - sentAt).toBeLessThan(1000);
  await expect.poll(() => statusesSince(marker)).toEqual(["aborted"]);
  await expect(playButton(page)).toHaveAttribute("title", "Play");
  server.releaseReplies();

  // The next read from the popup plays; the stopped read's cancellation had
  // long settled by then, and it raised no banner at any point.
  await playButton(page).click();
  const playing = await playingWithSound();
  expect(playing.textDigest).toBe(textDigest(SANDBOX_TEXT));
  expect(await errorBannerSeen(page)).toBe(false);
  await page.close();
});

test("a refused request settles idle and reaches the popup banner", async () => {
  // Negative control for the no-banner checks: the banner does appear when
  // the provider fails for real (a 400 is not retried).
  const marker = server.mark();
  const text = "A read the server refuses.";
  const page = await openPopup();
  server.speechStatus = 400;

  await request(page, "readAloud", { text });
  await expect(errorBanner(page)).toBeVisible();
  await expect(page.getByText(/HTTP 400 \(fake server answered 400\)/)).toBeVisible();
  await playbackReaches("idle");
  expect(speechSince(marker).map(({ input, status }) => ({ input, status }))).toEqual([
    { input: text, status: "completed" },
  ]);
  server.speechStatus = 200;

  // The next read replays the sandbox text's cached audio (the earlier step
  // synthesized it with the same settings), so no request goes out; it plays
  // and the banner is gone.
  await playButton(page).click();
  const playing = await playingWithSound();
  expect(playing.textDigest).toBe(textDigest(SANDBOX_TEXT));
  await expect(errorBanner(page)).toHaveCount(0);
  expect(await errorBannerSeen(page)).toBe(true);
  expect(speechSince(marker).map(({ input, status }) => ({ input, status }))).toEqual([
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
  await playbackReaches("idle");
  await expect(playButton(popup)).toHaveAttribute("title", "Play");
  await playButton(popup).click();

  const playing = await playingWithSound();
  expect(playing.textDigest).toBe(textDigest(SELECTED_TEXT));
  expect(speechSince(marker).map(({ input, status }) => ({ input, status }))).toEqual([
    { input: SELECTED_TEXT, status: "completed" },
  ]);
  expect(targetsSince(marker)).toEqual([PICKED]);
  await article.close();
  await popup.close();
});

test("two quick preview presses cancel one preview and leave the row unpressed", async () => {
  const marker = server.mark();
  const page = await openPopup("Preferences");
  const preview = page.getByRole("button", { name: "Preview" }).first();
  server.holdReplies();

  await preview.click();
  await expect(preview).toHaveAttribute("aria-pressed", "true");
  await pendingSpeech(marker, PREVIEW_CHUNKS.length);
  await preview.click();

  await expect(preview).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => statusesSince(marker)).toEqual(["aborted", "aborted"]);
  server.releaseReplies();

  // A third press starts a fresh preview with two seconds of audio per
  // chunk. The row turns pressed, stays so for as long as that audio lasts,
  // and clears at its natural end: a preview that never sounded would clear
  // the moment its replies went out. Both instants come from their own
  // recorders (the server stamps its replies, the page stamps the row's
  // flips), so when this process looks does not enter the measurement.
  server.audioSeconds = 2;
  const replay = server.mark();
  const flipsBefore = (await observations(page)).previewFlips.length;
  await preview.click();
  await expect.poll(() => statusesSince(replay)).toEqual(["completed", "completed"]);
  const replies = speechSince(replay).flatMap((r) =>
    r.status === "completed" ? [r.completedAt] : [],
  );
  expect(replies).toHaveLength(PREVIEW_CHUNKS.length);
  await expect
    .poll(async () => (await observations(page)).previewFlips.slice(flipsBefore).length, {
      timeout: 15_000,
    })
    .toBe(2);
  const [pressed, cleared] = (await observations(page)).previewFlips.slice(flipsBefore);
  expect(pressed?.pressed).toBe(true);
  expect(cleared?.pressed).toBe(false);
  expect((cleared?.at ?? 0) - Math.max(...replies)).toBeGreaterThanOrEqual(
    PREVIEW_CHUNKS.length * 2000 - 250,
  );
  await expect(preview).toHaveAttribute("aria-pressed", "false");
  expect(await errorBannerSeen(page)).toBe(false);

  // The row previewed is the selected voice's, so every audition request
  // asked for the picked pair.
  expect(inputsSince(marker)).toEqual([...PREVIEW_CHUNKS, ...PREVIEW_CHUNKS].sort());
  expect(targetsSince(marker)).toEqual(Array(2 * PREVIEW_CHUNKS.length).fill(PICKED));
  await page.close();
});

test("two fast Save & tests with different keys store only the second key", async () => {
  const olderKey = "fake-key-two";
  const newerKey = "fake-key-three";

  // Each popup holds its own draft; the background serializes the two
  // validations and lets only the newest persist.
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

  await expect(newerRow.getByText("All 1 engines work with your key")).toBeVisible({
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
