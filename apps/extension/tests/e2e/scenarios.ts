import { expect, test } from "@playwright/test";
import { textDigest } from "../../src/lib/digest";
import type { Playback } from "../../src/lib/playback";
import type { RouteId } from "../../src/lib/protocol";
import { previewStaysPressedFor, stopSettlesIdleWithinASecond } from "./assertions";
import {
  inputsSince,
  pendingSpeech,
  speechSince,
  statusesSince,
  targetsSince,
} from "./fake-provider/requests";
import type { FakeSpeechServer } from "./fake-provider/server";
import type { PopupObservations } from "./page-recorder";
import { playbackReaches, playingWithSound } from "./playback-waits";

// The read-pipeline steps both browser suites run against the fake server, written against the popup as
// each harness drives it (Playwright on Chromium, Selenium on Firefox). A suite registers a step at its
// place in the serial order: the steps share the suite's browser profile and build on the ones before them.

export const SANDBOX_TEXT = "Hello! This text will be read aloud by the selected voice.";
// The provider packs sentences up to its limit, so a short text is one request.
const SANDBOX_CHUNKS = [SANDBOX_TEXT];
const PREVIEW_CHUNKS = ["Hello! This is how I sound."];
export const API_KEY = "fake-key-one";
// The provider's model when the model field is left empty; the first step
// picks the voice by hand, and every later read and preview must ask for that pair.
export const MODEL = "tts-1";
export const PICKED = { voice: "beta", model: MODEL };

type Popup = { close(): Promise<void> };

/** `P` is the harness's handle for one open popup: Playwright's Page on Chromium, Selenium's
 *  FirefoxPopup on Firefox. */
export interface ScenarioDriver<P extends Popup> {
  readonly server: FakeSpeechServer;
  openPopup(view?: "Preferences"): Promise<P>;
  /** A background request from the popup's context, awaited to its reply; `sentAt` is on the page's clock. */
  request(
    popup: P,
    id: RouteId<"background">,
    payload?: unknown,
  ): Promise<{ sentAt: number; reply: unknown }>;
  playback(popup: P): Promise<Playback>;
  observations(popup: P): Promise<PopupObservations>;
  errorBannerSeen(popup: P): Promise<boolean>;
  textareaValue(popup: P): Promise<string | null>;
  /** The play control's title, "Play" or "Pause". */
  playButtonTitle(popup: P): Promise<string | null>;
  clickPlay(popup: P): Promise<void>;
  /** The first voice row's Preview control: its aria-pressed, and a press. */
  previewPressed(popup: P): Promise<string | null>;
  clickPreview(popup: P): Promise<void>;
}

type Scenario = <P extends Popup>(driver: ScenarioDriver<P>) => Promise<void>;

const scenarios = {
  "a read goes synthesizing, then playing, and the position advances": async (driver) => {
    const { server, openPopup, textareaValue, clickPlay, playback, playButtonTitle } = driver;
    const marker = server.mark();
    const popup = await openPopup();
    await expect.poll(() => textareaValue(popup)).toBe(SANDBOX_TEXT);
    server.holdReplies();
    await clickPlay(popup);

    await playbackReaches(() => playback(popup), "synthesizing");
    await pendingSpeech(server, marker, SANDBOX_CHUNKS.length);
    server.releaseReplies();

    const playing = await playingWithSound(() => playback(popup));
    expect(playing.textDigest).toBe(textDigest(SANDBOX_TEXT));
    await expect.poll(() => playButtonTitle(popup)).toBe("Pause");

    const later = await playbackReaches(() => playback(popup), "playing", {
      where: (doc) => doc.currentTime > 1,
    });
    expect(later.currentTime).toBeGreaterThan(1);

    expect(inputsSince(server, marker)).toEqual(SANDBOX_CHUNKS);
    expect(
      speechSince(server, marker).map(
        ({ voice, model, responseFormat, authorization, status }) => ({
          voice,
          model,
          responseFormat,
          authorization,
          status,
        }),
      ),
    ).toEqual(
      SANDBOX_CHUNKS.map(() => ({
        ...PICKED,
        responseFormat: "mp3",
        authorization: `Bearer ${API_KEY}`,
        status: "completed",
      })),
    );
    await popup.close();
  },

  "a second read cancels the first one's request at the server": async (driver) => {
    const { server, openPopup, request, playback } = driver;
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
  },

  "a stop mid-synthesis settles idle within a second and shows no error": async (driver) => {
    const {
      server,
      openPopup,
      request,
      observations,
      playButtonTitle,
      clickPlay,
      playback,
      errorBannerSeen,
    } = driver;
    const marker = server.mark();
    const text = "A read that is stopped before its request completes.";
    const popup = await openPopup();
    server.holdReplies();

    await request(popup, "readAloud", { text });
    await pendingSpeech(server, marker, 1);
    // Timed on the page's clock: from the stop being sent to the idle document
    // landing, as the page's history recorded it.
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
  },

  "two quick preview presses cancel one preview and leave the row unpressed": async (driver) => {
    const { server, openPopup, clickPreview, previewPressed, observations, errorBannerSeen } =
      driver;
    const marker = server.mark();
    const popup = await openPopup("Preferences");
    server.holdReplies();

    await clickPreview(popup);
    await expect.poll(() => previewPressed(popup)).toBe("true");
    await pendingSpeech(server, marker, PREVIEW_CHUNKS.length);
    await clickPreview(popup);

    await expect.poll(() => previewPressed(popup)).toBe("false");
    await expect
      .poll(() => statusesSince(server, marker))
      .toEqual(PREVIEW_CHUNKS.map(() => "aborted"));
    server.releaseReplies();

    // The pressed span is measured between two recorders (the server stamps its replies, the page stamps the flips),
    // so when this process looks does not enter the measurement.
    server.audioSeconds = 2;
    const replay = server.mark();
    const flipsBefore = (await observations(popup)).previewFlips.length;
    await clickPreview(popup);
    await expect
      .poll(() => statusesSince(server, replay))
      .toEqual(PREVIEW_CHUNKS.map(() => "completed"));
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
    expect(await previewPressed(popup)).toBe("false");
    expect(await errorBannerSeen(popup)).toBe(false);

    // The row previewed is the selected voice's, so every audition request
    // asked for the picked pair.
    expect(inputsSince(server, marker)).toEqual([...PREVIEW_CHUNKS, ...PREVIEW_CHUNKS]);
    expect(targetsSince(server, marker)).toEqual(Array(2 * PREVIEW_CHUNKS.length).fill(PICKED));
    await popup.close();
  },
} satisfies Record<string, Scenario>;

type SharedTitle = keyof typeof scenarios;

/** Registers the step under its title at this point of the suite's serial order. `driver` is read when
 *  the step runs, so it may close over state the suite's beforeAll has not created yet. */
export function registerSharedScenario<P extends Popup>(
  title: SharedTitle,
  driver: () => ScenarioDriver<P>,
): void {
  test(title, () => scenarios[title](driver()));
}
