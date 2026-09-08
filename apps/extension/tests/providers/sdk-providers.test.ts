import { DescribeVoicesCommand, PollyClient, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlotAbortError } from "@/lib/slot";
import { polly } from "@/providers/polly";
import { sdkError, sdkOutput } from "../helpers/sdk-error";
import { synthArgs } from "../helpers/synth-args";

// ---------------------------------------------------------------------------
// Polly with the real SDK client and a spied `send`: format-map fallbacks,
// SSML vs plain-text branches, voice normalization, the abort signal handed
// to every send, and the retry budget (the client itself must not retry).
// ---------------------------------------------------------------------------

const CREDS_POLLY = { accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" };

const SUCCESS = sdkOutput({
  AudioStream: { transformToByteArray: () => Promise.resolve(new Uint8Array([1, 2])) },
  Voices: [
    {
      Id: "Joanna",
      Gender: "Female",
      LanguageCode: "en-US",
      SupportedEngines: ["neural", "standard"],
    },
  ],
});

// Every `send(command, options)` across all clients, with the client it ran
// on, so tests can assert the abort signal each command carried and the
// client's resolved retry config.
const pollySends: Array<{ client: PollyClient; command: unknown; options: unknown }> = [];
let respond: () => Promise<unknown> = () => Promise.resolve(SUCCESS);

beforeEach(() => {
  pollySends.splice(0);
  respond = () => Promise.resolve(SUCCESS);
  // The Node http handler resolves the AWS defaults mode in its constructor;
  // "auto" (from the developer's env or ~/.aws/config) would probe IMDS.
  vi.stubEnv("AWS_DEFAULTS_MODE", "standard");
  vi.spyOn(PollyClient.prototype, "send").mockImplementation(function (
    this: PollyClient,
    command: unknown,
    options: unknown,
  ) {
    pollySends.push({ client: this, command, options });
    return respond();
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("polly synthesize (SDK send spied)", () => {
  it("returns concatenated bytes with the requested format metadata", async () => {
    const result = await polly.synthesize(
      synthArgs({
        text: "Hello there.",
        voiceId: "Joanna",
        model: "neural",
        encoding: "MP3_64_KBPS",
        speed: 1.5,
        pitch: 0,
        volumeGainDb: 0,
        credentials: CREDS_POLLY,
      }),
    );
    expect(result.extension).toBe("mp3");
    expect(result.bytes.length).toBeGreaterThan(0);
  });

  it("passes the caller's signal to every SynthesizeSpeech send", async () => {
    const signal = new AbortController().signal;
    // Two sentences that only fit in separate 3000-char chunks: two sends.
    const sentence = `${"word ".repeat(500)}end.`;
    await polly.synthesize(
      synthArgs({
        text: `${sentence} ${sentence}`,
        voiceId: "Joanna",
        model: "neural",
        credentials: CREDS_POLLY,
        signal,
      }),
    );
    expect(pollySends).toHaveLength(2);
    for (const { command, options } of pollySends) {
      expect(command).toBeInstanceOf(SynthesizeSpeechCommand);
      expect(options).toEqual({ abortSignal: signal });
    }
  });

  it("falls back to the first format for unknown encodings", async () => {
    const result = await polly.synthesize(
      synthArgs({
        text: "Hi.",
        voiceId: "Joanna",
        model: "standard",
        encoding: "UNKNOWN_FORMAT",
        speed: 1,
        pitch: 0,
        volumeGainDb: 0,
        credentials: CREDS_POLLY,
      }),
    );
    expect(result.extension).toBe("mp3");
  });

  it.each([
    [
      "an empty AudioStream",
      sdkOutput({
        AudioStream: { transformToByteArray: () => Promise.resolve(new Uint8Array(0)) },
      }),
    ],
    ["no AudioStream", sdkOutput({})],
  ])("rejects a response with %s as a synthesis failure, without a retry", async (_, answer) => {
    respond = () => Promise.resolve(answer);
    await expect(
      polly.synthesize(
        synthArgs({ text: "Hi.", voiceId: "Joanna", model: "neural", credentials: CREDS_POLLY }),
      ),
    ).rejects.toMatchObject({
      name: "ProviderHttpError",
      provider: "polly",
      operation: "synthesis",
      status: 200,
      message: "Amazon Polly synthesis failed: HTTP 200 (no audio in the response)",
    });
    expect(pollySends).toHaveLength(1);
  });

  it("reports the status the SDK resolved with when a 204 carries no audio", async () => {
    respond = () => Promise.resolve(sdkOutput({}, 204));
    await expect(
      polly.synthesize(
        synthArgs({ text: "Hi.", voiceId: "Joanna", model: "neural", credentials: CREDS_POLLY }),
      ),
    ).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 204,
      message: "Amazon Polly synthesis failed: HTTP 204 (no audio in the response)",
    });
  });

  it("normalizes voices via fetchVoices, with the caller's signal on DescribeVoices", async () => {
    const signal = new AbortController().signal;
    const voices = await polly.fetchVoices(CREDS_POLLY, signal);
    expect(voices).toEqual([
      {
        id: "Joanna",
        providerId: "polly",
        displayName: "Joanna",
        languageCodes: ["en-US"],
        gender: "Female",
        models: ["neural", "standard"],
        sampleRate: 22050,
      },
    ]);
    expect(pollySends).toHaveLength(1);
    expect(pollySends[0]?.command).toBeInstanceOf(DescribeVoicesCommand);
    expect(pollySends[0]?.options).toEqual({ abortSignal: signal });
  });

  it("validateAndFetchVoices returns the proven voice list", async () => {
    expect((await polly.validateAndFetchVoices(CREDS_POLLY))[0]?.id).toBe("Joanna");
  });
});

describe("polly retry budget", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Jitter factor 1: backoffs are exactly 500 ms, then 1000 ms.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a throttled chunk exactly three times, on a client that does not retry itself", async () => {
    const error = sdkError("ThrottlingException", 400);
    respond = () => Promise.reject(error);
    const outcome = polly.synthesize(
      synthArgs({ text: "Hi.", voiceId: "Joanna", model: "neural", credentials: CREDS_POLLY }),
    );
    outcome.catch(() => {});

    await vi.advanceTimersByTimeAsync(500 + 1000);
    await expect(outcome).rejects.toBe(error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollySends).toHaveLength(3);
    // The SDK's own retry layer is off: every send above is a single request.
    await expect(pollySends[0]?.client.config.maxAttempts()).resolves.toBe(1);
  });

  it("sends nothing more once the read is aborted during the backoff", async () => {
    const controller = new AbortController();
    respond = () => Promise.reject(sdkError("ServiceUnavailableException", 503));
    const outcome = polly.synthesize(
      synthArgs({
        text: "Hi.",
        voiceId: "Joanna",
        model: "neural",
        credentials: CREDS_POLLY,
        signal: controller.signal,
      }),
    );
    outcome.catch(() => {});

    await vi.advanceTimersByTimeAsync(100);
    const reason = new SlotAbortError("superseded");
    controller.abort(reason);

    await expect(outcome).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pollySends).toHaveLength(1);
  });
});
