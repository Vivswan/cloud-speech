import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { textDigest } from "../../src/lib/digest";
import type { Playback } from "../../src/lib/playback";
import type { RouteId } from "../../src/lib/protocol";
import type { Settings } from "../../src/lib/storage";
import {
  previewStaysPressedFor,
  resumeContinuesFrom,
  stopSettlesIdleWithinASecond,
} from "../assertions";
import {
  inputsSince,
  pendingSpeech,
  speechSince,
  statusesSince,
  targetsSince,
} from "../fake-provider/requests";
import {
  DEFAULT_AUDIO_SECONDS,
  type FakeSpeechServer,
  startFakeSpeechServer,
} from "../fake-provider/server";
import { readToastFonts, TOAST_ERROR, TOAST_FONT, type ToastFonts } from "../font-probe";
import {
  installPopupRecorder,
  type PopupObservations,
  readPopupObservations,
} from "../page-recorder";
import { type PlaybackAt, playbackReaches, playingWithSound } from "../playback-waits";
import {
  EXTENSION_PATH,
  type FirefoxExtensionSession,
  type FirefoxPopup,
  launchFirefoxExtension,
} from "./fixtures";

// The read pipeline on the Firefox build, in a real stock Firefox: there is no
// offscreen document, so the audio session runs inside the background event
// page and its events never cross a context boundary. Save & test, a read,
// pause/resume, a read to its end, supersession, stop, a refused request, an
// unreachable server, and preview toggling, against the same local fake
// server as the Chromium suite. The steps share one browser profile and build
// on each other in order. Set E2E_FIREFOX_LONG=1 to also hold a pause across
// two minutes (Firefox suspends an idle event page after about 30 s).

const SANDBOX_TEXT = "Hello! This text will be read aloud by the selected voice.";
const SANDBOX_CHUNKS = ["Hello!", "This text will be read aloud by the selected voice."];
const PREVIEW_CHUNKS = ["Hello!", "This is how I sound."];
const API_KEY = "fake-key-one";
const MODEL = "tts-1";
const PICKED = { voice: "beta", model: MODEL };
const BANNER_TITLE = "Could not read aloud";
/** Port 9 is on Firefox's banned-port list: the provider's fetch fails
 *  before any connection is attempted. */
const UNREACHABLE_URL = "http://localhost:9/v1";

test.describe.configure({ mode: "serial" });

let server: FakeSpeechServer;
let extension: FirefoxExtensionSession;

test.beforeAll(async () => {
  server = await startFakeSpeechServer();
  extension = await launchFirefoxExtension();
});

test.afterAll(async () => {
  try {
    await extension?.close();
  } finally {
    await server?.close();
  }
});

test.afterEach(() => {
  server.releaseReplies();
  server.speechStatus = 200;
  server.audioSeconds = DEFAULT_AUDIO_SECONDS;
});

// --- Page-side recording -----------------------------------------------------------

/** The extension API as the page-side functions below see it, only the parts
 *  they touch. */
declare const browser: {
  storage: {
    sync: { get(key: string): Promise<Record<string, unknown>> };
    session: {
      get(key: string): Promise<Record<string, unknown>>;
    };
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    getBackgroundPage(): Promise<{ performance: { timeOrigin: number } } | null>;
  };
  tabs: {
    query(query: Record<string, never>): Promise<{ id: number; url?: string }[]>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

async function openPopup(view?: "Preferences" | "Settings"): Promise<FirefoxPopup> {
  const popup = await extension.openPopup(view);
  await popup.evaluate(installPopupRecorder, { api: "browser", bannerTitle: BANNER_TITLE });
  return popup;
}

function observations(popup: FirefoxPopup): Promise<PopupObservations> {
  return popup.evaluate(readPopupObservations);
}

async function errorBannerSeen(popup: FirefoxPopup): Promise<boolean> {
  return (await observations(popup)).errorBannerSeen;
}

// --- Extension state, read where the background keeps it -----------------------

/** The playback document (storage.session), as the background last wrote it. */
async function playback(popup: FirefoxPopup): Promise<Playback> {
  const stored = await popup.evaluate<Record<string, unknown>>(() =>
    browser.storage.session.get("playback"),
  );
  return (stored.playback as Playback | undefined) ?? { status: "idle", epoch: 0, rate: 1 };
}

async function settings(popup: FirefoxPopup): Promise<Settings> {
  const stored = await popup.evaluate<Record<string, unknown>>(() =>
    browser.storage.sync.get("settings"),
  );
  return stored.settings as Settings;
}

/** The background event page's performance.timeOrigin: it changes exactly
 *  when Firefox recycles the page, so an unchanged value across a wait is the
 *  page having stayed alive through it. */
function backgroundStartedAt(popup: FirefoxPopup): Promise<number> {
  return popup.evaluate(async () => {
    const page = await browser.runtime.getBackgroundPage();
    if (!page) throw new Error("the background event page is not running");
    return page.performance.timeOrigin;
  });
}

/** A background request sent from the popup's own context and awaited to its
 *  reply; `sentAt` is the page's Date.now() right before the send. The
 *  envelope is built here: WebDriver hands `undefined` arguments to the page
 *  as `null`, which a payload-less route rejects. */
function request(
  popup: FirefoxPopup,
  id: RouteId<"background">,
  payload?: unknown,
): Promise<{ sentAt: number; reply: unknown }> {
  const envelope =
    payload === undefined ? { to: "background", id } : { to: "background", id, payload };
  return popup.evaluate(async (envelope: unknown) => {
    const sentAt = Date.now();
    const reply = await browser.runtime.sendMessage(envelope);
    return { sentAt, reply };
  }, envelope);
}

// --- Popup controls -------------------------------------------------------------

const PLAY_BUTTON = '//button[@title="Play" or @title="Pause"]';

async function playButtonTitle(popup: FirefoxPopup): Promise<string | null> {
  return (await popup.find(PLAY_BUTTON)).getAttribute("title");
}

async function clickPlay(popup: FirefoxPopup): Promise<void> {
  await (await popup.find(PLAY_BUTTON)).click();
}

async function openCustomProviderRow(popup: FirefoxPopup) {
  return popup.providerRow("custom", "OpenAI-compatible");
}

async function saveAndTest(
  popup: FirefoxPopup,
  fields: { serverUrl?: string; apiKey?: string },
): Promise<{ clickedAt: number }> {
  const row = await openCustomProviderRow(popup);
  if (fields.serverUrl !== undefined) {
    const input = await popup.labelled(row, "Server URL");
    await input.clear();
    await input.sendKeys(fields.serverUrl);
  }
  if (fields.apiKey !== undefined) {
    await (await popup.labelled(row, "API key (optional)")).sendKeys(fields.apiKey);
  }
  const clickedAt = Date.now();
  await (await popup.find('//button[normalize-space(.)="Save & test"]')).click();
  return { clickedAt };
}

/** Wait until the page shows `needle` and return the page text that did. */
async function textShows(popup: FirefoxPopup, needle: string, timeout = 15_000): Promise<string> {
  let text = "";
  await expect
    .poll(
      async () => {
        text = await popup.text();
        return text.includes(needle);
      },
      { message: `popup shows "${needle}"`, timeout },
    )
    .toBe(true);
  return text;
}

/** From a read that is playing, pause it and return the parked document. */
async function pauseParked(popup: FirefoxPopup): Promise<PlaybackAt<"paused">> {
  expect((await request(popup, "playerPause")).reply).toEqual({ ok: true, value: true });
  const paused = await playbackReaches(() => playback(popup), "paused");
  expect(paused.currentTime).toBeGreaterThan(0);
  await expect.poll(() => playButtonTitle(popup)).toBe("Play");
  return paused;
}

/** Resume a parked read from a fresh popup and check every position the
 *  element reports afterwards against the parked one. */
async function resumeFromParked(popup: FirefoxPopup, parkedAt: number): Promise<void> {
  await expect.poll(() => playButtonTitle(popup)).toBe("Play");
  const slider = await popup.find('//*[@role="slider"]');
  expect(await slider.getAttribute("aria-valuenow")).toBe(String(parkedAt));
  await clickPlay(popup);
  await resumeContinuesFrom(() => observations(popup), parkedAt);
}

// --- Steps -------------------------------------------------------------------------

test("Save & test connects the fake server and a voice can be picked", async () => {
  const marker = server.mark();
  const popup = await openPopup("Settings");
  await saveAndTest(popup, { serverUrl: `${server.origin}/v1`, apiKey: API_KEY });
  const text = await textShows(popup, "All 1 engines work with your key");
  expect(text).toContain("Connected");
  expect(text).toContain("2 voices");

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

  // The first voice was picked automatically; pick the other one by hand.
  await (await popup.find('//a[normalize-space(.)="Preferences"]')).click();
  await (await popup.find('//button[starts-with(normalize-space(.), "alpha")]')).click();
  await (await popup.find('//button[starts-with(normalize-space(.), "beta")]')).click();
  await popup.find('//button[starts-with(normalize-space(.), "beta")]');
  // The fake server only speaks MP3, which is the provider's first read-aloud
  // format and so the default the format select resolves to.
  expect(
    await popup.evaluate<number>(
      () =>
        [...document.querySelectorAll('[role="combobox"]')].filter((el) =>
          el.textContent?.includes("MP3"),
        ).length,
    ),
  ).toBe(2);

  await expect
    .poll(async () => {
      const current = await settings(popup);
      return {
        selection: current.selection,
        credentials: current.perProvider.custom?.credentials,
      };
    })
    .toEqual({
      selection: { providerId: "custom", voiceId: PICKED.voice, model: PICKED.model },
      credentials: { apiKey: API_KEY, baseUrl: `${server.origin}/v1` },
    });
  await popup.close();
});

test("a read goes synthesizing, then playing, and the position advances", async () => {
  // The Firefox build compiles the offscreen route out of the background;
  // the source still carries it (the control for the grep).
  const background = readFileSync(resolve(EXTENSION_PATH, "background.js"), "utf8");
  const source = readFileSync(resolve(EXTENSION_PATH, "../../src/lib/audio-host.ts"), "utf8");
  expect(source).toContain("offscreen");
  expect(background).not.toContain("offscreen");

  const marker = server.mark();
  const popup = await openPopup();
  expect(await (await popup.find("//textarea")).getAttribute("value")).toBe(SANDBOX_TEXT);
  server.holdReplies();
  await clickPlay(popup);

  await playbackReaches(() => playback(popup), "synthesizing");
  await pendingSpeech(server, marker, SANDBOX_CHUNKS.length);
  server.releaseReplies();

  const playing = await playingWithSound(() => playback(popup));
  expect(playing.textDigest).toBe(textDigest(SANDBOX_TEXT));
  await expect.poll(() => playButtonTitle(popup)).toBe("Pause");

  // Both chunks stitched: the timeline spans more than one reply's audio.
  const later = await playbackReaches(() => playback(popup), "playing", {
    where: (doc) => doc.currentTime > 1 && doc.duration > server.audioSeconds * 1.5,
  });
  expect(later.currentTime).toBeGreaterThan(1);

  expect(inputsSince(server, marker)).toEqual([...SANDBOX_CHUNKS].sort());
  expect(
    speechSince(server, marker).map(({ voice, model, responseFormat, authorization, status }) => ({
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
      authorization: `Bearer ${API_KEY}`,
      status: "completed",
    })),
  );
  await popup.close();
});

/** The audio session's events, as the background routes that carry them on
 *  Chrome (lib/audio-session.ts); on Firefox none may travel as a message. */
function audioEnvelopes(observed: PopupObservations) {
  return observed.envelopes.filter((envelope) =>
    ["audioProgress", "audioEnded", "keepalive"].includes(String(envelope.id)),
  );
}

/** From a fresh popup, pause the read that is playing; the popup stays open
 *  for whatever the caller wants to read before closing it. */
async function parkFromFreshPopup(): Promise<{
  popup: FirefoxPopup;
  paused: PlaybackAt<"paused">;
}> {
  const popup = await openPopup();
  await expect.poll(() => playButtonTitle(popup)).toBe("Pause");
  const paused = await pauseParked(popup);
  return { popup, paused };
}

async function reopenAfter(
  popup: FirefoxPopup,
  closedMs: number,
  openMs: number,
): Promise<FirefoxPopup> {
  await popup.close();
  await new Promise((resolve) => setTimeout(resolve, closedMs));
  const reopened = await openPopup();
  await new Promise((resolve) => setTimeout(resolve, openMs));
  return reopened;
}

test("a pause survives a closed popup and resumes from the parked position", async () => {
  const { popup, paused } = await parkFromFreshPopup();
  const reopened = await reopenAfter(popup, 2000, 0);
  expect(await playback(reopened)).toEqual(paused);
  await resumeFromParked(reopened, paused.currentTime);
  await reopened.close();
});

// Firefox suspends an idle event page after about 30 s; the hold outlasts
// that, and its second minute keeps a popup open so the recorder covers the
// session's 20 s keepalive period, which on Firefox is an extension API call
// and not a message.
test("a pause held two minutes, the second with a popup open, keeps the event page and resumes from it", async () => {
  test.skip(!process.env.E2E_FIREFOX_LONG, "set E2E_FIREFOX_LONG=1 to hold");
  test.setTimeout(180_000);
  const { popup, paused } = await parkFromFreshPopup();
  const startedAt = await backgroundStartedAt(popup);
  const reopened = await reopenAfter(popup, 60_000, 60_000);
  expect(await playback(reopened)).toEqual(paused);
  expect(await backgroundStartedAt(reopened)).toBe(startedAt);
  expect(audioEnvelopes(await observations(reopened))).toEqual([]);
  await resumeFromParked(reopened, paused.currentTime);
  await reopened.close();
});

test("a short read ends inside the event page, and no audio event crossed a context", async () => {
  // Every position tick and the end itself land in storage.session, written
  // by the session from inside the background: no runtime message carries
  // them there. (The refused-request step shows the same recorder catching a
  // message that does cross.)
  const marker = server.mark();
  const text = "A short read. It ends on its own.";
  const chunks = ["A short read.", "It ends on its own."];
  server.audioSeconds = 2;
  const popup = await openPopup();

  await request(popup, "readAloud", { text });
  const ended = await playbackReaches(() => playback(popup), "paused", {
    where: (doc) => doc.textDigest === textDigest(text),
  });
  expect(ended.duration).toBeGreaterThan(server.audioSeconds * 1.5);
  expect(ended.currentTime).toBeCloseTo(ended.duration, 1);
  await expect.poll(() => playButtonTitle(popup)).toBe("Play");

  const observed = await observations(popup);
  const positions = observed.playbackHistory.flatMap((entry) =>
    entry.doc.status === "playing" && entry.doc.textDigest === textDigest(text)
      ? [entry.doc.currentTime]
      : [],
  );
  expect(positions.filter((position) => position > 0).length).toBeGreaterThanOrEqual(2);
  expect(positions).toEqual([...positions].sort((a, b) => a - b));
  expect(audioEnvelopes(observed)).toEqual([]);
  expect(inputsSince(server, marker)).toEqual([...chunks].sort());
  expect(targetsSince(server, marker)).toEqual([PICKED, PICKED]);
  await popup.close();
});

test("a second read cancels the first one's request at the server", async () => {
  const marker = server.mark();
  const first = "The first read, superseded while its request is still open.";
  const second = "The second read, which is the one that plays.";
  const popup = await openPopup();
  server.holdReplies();

  await request(popup, "readAloud", { text: first });
  await pendingSpeech(server, marker, 1);
  await request(popup, "readAloud", { text: second });

  await expect
    .poll(() => speechSince(server, marker).map(({ input, status }) => ({ input, status })), {
      message: "the fake server saw the first request's connection close",
    })
    .toEqual([
      { input: first, status: "aborted" },
      { input: second, status: "pending" },
    ]);
  server.releaseReplies();

  const playing = await playingWithSound(() => playback(popup));
  expect(playing.textDigest).toBe(textDigest(second));
  expect(speechSince(server, marker).map(({ input, status }) => ({ input, status }))).toEqual([
    { input: first, status: "aborted" },
    { input: second, status: "completed" },
  ]);
  expect(targetsSince(server, marker)).toEqual([PICKED, PICKED]);
  await popup.close();
});

test("a stop mid-synthesis settles idle within a second and shows no error", async () => {
  const marker = server.mark();
  const text = "A read that is stopped before its request completes.";
  const popup = await openPopup();
  server.holdReplies();

  await request(popup, "readAloud", { text });
  await pendingSpeech(server, marker, 1);
  const { sentAt } = await request(popup, "stopReading");
  await stopSettlesIdleWithinASecond(() => observations(popup), sentAt);
  await expect.poll(() => statusesSince(server, marker)).toEqual(["aborted"]);
  await expect.poll(() => playButtonTitle(popup)).toBe("Play");
  server.releaseReplies();

  await clickPlay(popup);
  const playing = await playingWithSound(() => playback(popup));
  expect(playing.textDigest).toBe(textDigest(SANDBOX_TEXT));
  expect(await errorBannerSeen(popup)).toBe(false);
  await popup.close();
});

test("a refused request settles idle and reaches the popup banner", async () => {
  // Negative control for the no-banner checks, and for the envelope recorder:
  // the banner's own message is one that crosses from the background.
  const marker = server.mark();
  const text = "A read the server refuses.";
  const popup = await openPopup();
  server.speechStatus = 400;

  await request(popup, "readAloud", { text });
  const shown = await textShows(popup, BANNER_TITLE);
  // Plain words up front, the raw provider text behind the Details disclosure
  // (Selenium's page text is the rendered text, so a collapsed Details hides
  // its content from it).
  expect(shown).toContain(
    "OpenAI-compatible could not read this text with this voice. Try another voice.",
  );
  expect(shown).not.toMatch(/HTTP 400/);
  await (await popup.find('//summary[normalize-space(.)="Details"]')).click();
  await textShows(popup, "HTTP 400 (fake server answered 400)");
  await playbackReaches(() => playback(popup), "idle");
  expect(speechSince(server, marker).map(({ input, status }) => ({ input, status }))).toEqual([
    { input: text, status: "completed" },
  ]);
  expect((await observations(popup)).envelopes.map(({ to, id }) => ({ to, id }))).toContainEqual({
    to: "popup",
    id: "backgroundError",
  });
  server.speechStatus = 200;

  // The next read replays the sandbox text's cached audio, so no request goes
  // out; it plays and the banner is gone.
  await clickPlay(popup);
  const playing = await playingWithSound(() => playback(popup));
  expect(playing.textDigest).toBe(textDigest(SANDBOX_TEXT));
  await expect.poll(() => popup.text()).not.toContain(BANNER_TITLE);
  expect(await errorBannerSeen(popup)).toBe(true);
  expect(speechSince(server, marker).map(({ input, status }) => ({ input, status }))).toEqual([
    { input: text, status: "completed" },
  ]);
  await popup.close();
});

test("an error toast on a web page renders in the bundled sans", async () => {
  const pageUrl = `${server.origin}/page`;
  const page = await extension.openPage(pageUrl);
  // Pushed from the popup's context the way the background does on a failed
  // read (lib/errors.ts); the popup is the extension page Marionette can run
  // scripts in.
  const popup = await openPopup();
  const reply = await popup.evaluate(
    async (url: string, payload: unknown) => {
      // Matched by exact URL: a match pattern cannot carry the server's port.
      const tab = (await browser.tabs.query({})).find((candidate) => candidate.url === url);
      if (!tab) throw new Error("the page tab is gone");
      return browser.tabs.sendMessage(tab.id, { to: "content", id: "setError", payload });
    },
    pageUrl,
    TOAST_ERROR,
  );
  expect(reply).toEqual({ ok: true });

  await page.focus();
  const fonts = await page.evaluate<ToastFonts>(readToastFonts, TOAST_FONT);
  expect(fonts.family).toMatch(new RegExp(`^"?${TOAST_FONT}"?, system-ui`));
  expect([...fonts.faces].sort()).toEqual([`${TOAST_FONT} 400 loaded`, `${TOAST_FONT} 600 loaded`]);

  await popup.close();
  await page.close();
});

test("Save & test against an unreachable server fails in the row and keeps the working credentials", async () => {
  const marker = server.mark();
  const popup = await openPopup("Settings");
  const { clickedAt } = await saveAndTest(popup, { serverUrl: UNREACHABLE_URL });
  const text = await textShows(popup, "Your previous working credentials were kept.", 30_000);
  const shownAfter = Date.now() - clickedAt;
  expect(text).toContain("Could not reach OpenAI-compatible");
  expect(text).toContain("Check your internet connection and try again.");
  // Well inside the provider's discovery deadline: the refusal, not a timeout,
  // ended the attempt.
  expect(shownAfter).toBeLessThan(10_000);
  expect(await errorBannerSeen(popup)).toBe(false);

  // No probe reached the fake server, and the stored credentials still point
  // at it: the next read plays from it.
  expect(speechSince(server, marker)).toEqual([]);
  expect((await settings(popup)).perProvider.custom?.credentials).toEqual({
    apiKey: API_KEY,
    baseUrl: `${server.origin}/v1`,
  });
  // The previous step's read may still be going; a fresh one replays the
  // sandbox text's cached audio, so the fake server still sees no synthesis.
  await request(popup, "stopReading");
  await playbackReaches(() => playback(popup), "idle");
  await (await popup.find('//a[normalize-space(.)="Sandbox"]')).click();
  await clickPlay(popup);
  const playing = await playingWithSound(() => playback(popup));
  expect(playing.textDigest).toBe(textDigest(SANDBOX_TEXT));
  expect(speechSince(server, marker)).toEqual([]);
  await popup.close();
});

test("two quick preview presses cancel one preview and leave the row unpressed", async () => {
  const marker = server.mark();
  const popup = await openPopup("Preferences");
  const PREVIEW = '(//button[@title="Preview"])[1]';
  const pressed = async () => (await popup.find(PREVIEW)).getAttribute("aria-pressed");
  server.holdReplies();

  await (await popup.find(PREVIEW)).click();
  await expect.poll(pressed).toBe("true");
  await pendingSpeech(server, marker, PREVIEW_CHUNKS.length);
  await (await popup.find(PREVIEW)).click();

  await expect.poll(pressed).toBe("false");
  await expect.poll(() => statusesSince(server, marker)).toEqual(["aborted", "aborted"]);
  server.releaseReplies();

  // A third press starts a fresh preview with two seconds of audio per
  // chunk. The row turns pressed, stays so for as long as that audio lasts,
  // and clears at its natural end; both instants come from their own
  // recorders (the server stamps its replies, the page stamps the flips).
  server.audioSeconds = 2;
  const replay = server.mark();
  const flipsBefore = (await observations(popup)).previewFlips.length;
  await (await popup.find(PREVIEW)).click();
  await expect.poll(() => statusesSince(server, replay)).toEqual(["completed", "completed"]);
  const replies = speechSince(server, replay).flatMap((r) =>
    r.status === "completed" ? [r.completedAt] : [],
  );
  expect(replies).toHaveLength(PREVIEW_CHUNKS.length);
  await previewStaysPressedFor(
    () => observations(popup),
    flipsBefore,
    replies,
    PREVIEW_CHUNKS.length * 2000,
  );
  expect(await pressed()).toBe("false");
  expect(await errorBannerSeen(popup)).toBe(false);

  // The row previewed is the selected voice's, so every audition request
  // asked for the picked pair.
  expect(inputsSince(server, marker)).toEqual([...PREVIEW_CHUNKS, ...PREVIEW_CHUNKS].sort());
  expect(targetsSince(server, marker)).toEqual(Array(2 * PREVIEW_CHUNKS.length).fill(PICKED));
  await popup.close();
});
