import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";
import { textDigest } from "../../src/lib/digest";
import type { Playback } from "../../src/lib/playback";
import type { RouteId } from "../../src/lib/protocol";
import type { Settings } from "../../src/lib/storage";
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
import {
  historyReaches,
  type PlaybackAt,
  playbackReaches,
  playingWithSound,
} from "../playback-waits";
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
const BANNER_TITLE = "Speech synthesis failed";
/** Nothing listens on the discard port; the provider's fetch fails fast. */
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
      onChanged: {
        addListener(
          listener: (changes: Record<string, { newValue?: unknown } | undefined>) => void,
        ): void;
      };
    };
  };
  runtime: {
    sendMessage(message: unknown): Promise<unknown>;
    onMessage: { addListener(listener: (message: unknown) => void): void };
    getBackgroundPage(): Promise<{ performance: { timeOrigin: number } } | null>;
  };
};

/** What a popup page records about itself from the moment it loads, each
 *  entry stamped with the page's own Date.now(); kept in the page so no
 *  transition is missed between reads from here. */
interface PopupObservations {
  /** The error banner has been shown at least once. */
  errorBannerSeen: boolean;
  /** Every playback document written while the page was open, in order. */
  playbackHistory: Array<{ at: number; doc: Playback }>;
  /** Every change of an audition row's pressed state, in order. */
  previewFlips: Array<{ at: number; pressed: boolean }>;
  /** Every runtime message another context sent while the page was open. On
   *  Chrome the offscreen document's position events travel this way; on
   *  Firefox nothing of the kind must. */
  envelopes: Array<{ at: number; to: unknown; id: unknown }>;
}

type ObservedWindow = { observed?: PopupObservations };

async function openPopup(view?: "Preferences" | "Settings"): Promise<FirefoxPopup> {
  const popup = await extension.openPopup(view);
  await popup.evaluate((title: string) => {
    const shown = () => document.body.innerText.includes(title);
    const observed: PopupObservations = {
      errorBannerSeen: shown(),
      playbackHistory: [],
      previewFlips: [],
      envelopes: [],
    };
    (window as ObservedWindow).observed = observed;
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
    browser.storage.session.onChanged.addListener((changes) => {
      const next = changes.playback?.newValue;
      if (next) observed.playbackHistory.push({ at: Date.now(), doc: next as Playback });
    });
    browser.runtime.onMessage.addListener((message) => {
      const envelope = (message ?? {}) as { to?: unknown; id?: unknown };
      observed.envelopes.push({ at: Date.now(), to: envelope.to, id: envelope.id });
    });
  }, BANNER_TITLE);
  return popup;
}

function observations(popup: FirefoxPopup): Promise<PopupObservations> {
  return popup.evaluate(() => {
    const observed = (window as ObservedWindow).observed;
    if (!observed) throw new Error("popup observations were never installed");
    return observed;
  });
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
 *  element reports afterwards against the parked one: the resume writes the
 *  parked position, and each later tick may exceed it by at most the page
 *  time elapsed since that write. */
async function resumeFromParked(popup: FirefoxPopup, parkedAt: number): Promise<void> {
  await expect.poll(() => playButtonTitle(popup)).toBe("Play");
  const slider = await popup.find('//*[@role="slider"]');
  expect(await slider.getAttribute("aria-valuenow")).toBe(String(parkedAt));
  await clickPlay(popup);

  const history = await historyReaches(
    () => observations(popup),
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

// A pause parks the read: nothing moves while the popup is closed, the event
// page is the same one afterwards, and the resume continues from the parked
// position. The long hold is opt-in; its second minute keeps a popup open so
// the recorder covers the session's 20 s keepalive period, which on Firefox
// is an extension API call and not a message.
const PAUSE_HOLDS = [
  { label: "two seconds with the popup closed", closedMs: 2000, openMs: 0, optIn: false },
  {
    label: "two minutes, the second with a popup open",
    closedMs: 60_000,
    openMs: 60_000,
    optIn: true,
  },
];

for (const hold of PAUSE_HOLDS) {
  test(`a pause held ${hold.label} keeps the event page and resumes from it`, async () => {
    test.skip(hold.optIn && !process.env.E2E_FIREFOX_LONG, "set E2E_FIREFOX_LONG=1 to hold");
    test.setTimeout(hold.closedMs + hold.openMs + 60_000);

    const popup = await openPopup();
    await expect.poll(() => playButtonTitle(popup)).toBe("Pause");
    const paused = await pauseParked(popup);
    const startedAt = await backgroundStartedAt(popup);
    await popup.close();

    await new Promise((resolve) => setTimeout(resolve, hold.closedMs));
    const reopened = await openPopup();
    await new Promise((resolve) => setTimeout(resolve, hold.openMs));
    expect(await playback(reopened)).toEqual(paused);
    expect(await backgroundStartedAt(reopened)).toBe(startedAt);
    expect(audioEnvelopes(await observations(reopened))).toEqual([]);
    await resumeFromParked(reopened, paused.currentTime);
    await reopened.close();
  });
}

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
  const history = await historyReaches(
    () => observations(popup),
    (entry) => entry.doc.status === "idle" && entry.at >= sentAt,
  );
  const idle = history.find((entry) => entry.doc.status === "idle" && entry.at >= sentAt);
  expect((idle?.at ?? Number.POSITIVE_INFINITY) - sentAt).toBeLessThan(1000);
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
  expect(shown).toMatch(/HTTP 400 \(fake server answered 400\)/);
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

test("Save & test against an unreachable server fails in the row and keeps the working credentials", async () => {
  const marker = server.mark();
  const popup = await openPopup("Settings");
  const { clickedAt } = await saveAndTest(popup, { serverUrl: UNREACHABLE_URL });
  const text = await textShows(popup, "Your previous working credentials were kept.", 30_000);
  const shownAfter = Date.now() - clickedAt;
  expect(text).toContain("The provider could not be reached from the extension.");
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
  await expect
    .poll(async () => (await observations(popup)).previewFlips.slice(flipsBefore).length, {
      timeout: 15_000,
    })
    .toBe(2);
  const [turnedOn, cleared] = (await observations(popup)).previewFlips.slice(flipsBefore);
  expect(turnedOn?.pressed).toBe(true);
  expect(cleared?.pressed).toBe(false);
  expect((cleared?.at ?? 0) - Math.max(...replies)).toBeGreaterThanOrEqual(
    PREVIEW_CHUNKS.length * 2000 - 250,
  );
  expect(await pressed()).toBe("false");
  expect(await errorBannerSeen(popup)).toBe(false);

  // The row previewed is the selected voice's, so every audition request
  // asked for the picked pair.
  expect(inputsSince(server, marker)).toEqual([...PREVIEW_CHUNKS, ...PREVIEW_CHUNKS].sort());
  expect(targetsSince(server, marker)).toEqual(Array(2 * PREVIEW_CHUNKS.length).fill(PICKED));
  await popup.close();
});
