import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// SDK-mocked Polly paths: format-map fallbacks, SSML vs plain-text branches,
// voice normalization, and the abort signal handed to every send.
// ---------------------------------------------------------------------------

// Every `send(command, options)` call across all clients, so tests can assert
// the abort signal each command carried.
const pollySends: Array<{ command: unknown; options: unknown }> = [];

vi.mock("@aws-sdk/client-polly", () => {
  class PollyClient {
    send = vi.fn((command: unknown, options: unknown) => {
      pollySends.push({ command, options });
      return Promise.resolve({
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
    });
    destroy = vi.fn();
  }
  class SynthesizeSpeechCommand {
    constructor(public input: unknown) {}
  }
  class DescribeVoicesCommand {
    constructor(public input: unknown) {}
  }
  return {
    PollyClient,
    SynthesizeSpeechCommand,
    DescribeVoicesCommand,
    Engine: {
      STANDARD: "standard",
      NEURAL: "neural",
      GENERATIVE: "generative",
      LONG_FORM: "long-form",
    },
    OutputFormat: { MP3: "mp3", OGG_VORBIS: "ogg_vorbis" },
    TextType: { SSML: "ssml", TEXT: "text" },
  };
});

import { DescribeVoicesCommand, SynthesizeSpeechCommand } from "@aws-sdk/client-polly";
import { polly } from "@/providers/polly";
import { synthArgs } from "../helpers/synth-args";

const CREDS_POLLY = { accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" };

describe("polly synthesize (SDK mocked)", () => {
  beforeEach(() => {
    pollySends.splice(0);
  });

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
