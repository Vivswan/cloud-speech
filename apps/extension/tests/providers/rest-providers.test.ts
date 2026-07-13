import { afterEach, describe, expect, it, vi } from "vitest";
import { google, modelFromVoiceName } from "@/providers/google";
import { openai } from "@/providers/openai";

function mockFetchOnce(response: unknown, ok = true, _binary = false) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: ok ? 200 : 403,
    json: () => Promise.resolve(response),
    arrayBuffer: () => Promise.resolve(response as ArrayBuffer),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("google provider (REST)", () => {
  it("infers the model family from the voice name", () => {
    expect(modelFromVoiceName("en-US-Wavenet-D")).toBe("wavenet");
    expect(modelFromVoiceName("en-US-Neural2-A")).toBe("neural2");
    expect(modelFromVoiceName("en-US-Chirp3-HD-Achernar")).toBe("chirp");
    expect(modelFromVoiceName("en-US-Standard-B")).toBe("standard");
  });

  it("fetches and normalizes voices", async () => {
    mockFetchOnce({
      voices: [
        {
          name: "en-US-Wavenet-D",
          languageCodes: ["en-US"],
          ssmlGender: "MALE",
          naturalSampleRateHertz: 24000,
        },
      ],
    });

    const voices = await google.fetchVoices({ apiKey: "key" });
    expect(voices).toEqual([
      {
        id: "en-US-Wavenet-D",
        providerId: "google",
        displayName: "en-US-Wavenet-D",
        languageCodes: ["en-US"],
        gender: "Male",
        models: ["wavenet"],
        sampleRate: 24000,
      },
    ]);
  });

  it("validateAndFetchVoices returns the proven voice list", async () => {
    mockFetchOnce({
      voices: [
        {
          name: "en-US-Standard-B",
          languageCodes: ["en-US"],
          ssmlGender: "MALE",
        },
      ],
    });

    expect((await google.validateAndFetchVoices({ apiKey: "key" }))[0]?.id).toBe(
      "en-US-Standard-B",
    );
  });

  it("throws on a non-OK voices response", async () => {
    mockFetchOnce({}, false);
    await expect(google.fetchVoices({ apiKey: "bad" })).rejects.toThrow("403");
  });

  it("synthesizes via the REST endpoint and decodes base64 audio", async () => {
    const fetchMock = mockFetchOnce({ audioContent: btoa("abc") });

    const result = await google.synthesize({
      text: "Hello.",
      voiceId: "en-US-Wavenet-D",
      model: "wavenet",
      encoding: "MP3",
      speed: 1.25,
      pitch: 2,
      volumeGainDb: 0,
      credentials: { apiKey: "key" },
    });

    expect([...result.bytes]).toEqual([97, 98, 99]);
    expect(result.extension).toBe("mp3");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("text:synthesize");
    // The API key travels in a header, never in the URL.
    expect(url).not.toContain("key=");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("key");
    const body = JSON.parse(String(init.body));
    expect(body.voice.name).toBe("en-US-Wavenet-D");
    expect(body.voice.languageCode).toBe("en-US");
    expect(body.audioConfig.speakingRate).toBe(1.25);
  });

  it("sends the API key as a header for the voices list", async () => {
    const fetchMock = mockFetchOnce({ voices: [] });
    await google.fetchVoices({ apiKey: "secret" }).catch(() => {});
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).not.toContain("secret");
    expect(url).not.toContain("key=");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("secret");
  });

  it("strips SSML markup when a no-SSML voice falls back to plain text", async () => {
    const fetchMock = mockFetchOnce({ audioContent: btoa("abc") });
    await google.synthesize({
      text: "<speak>Hi <break/> there</speak>",
      voiceId: "en-US-Chirp3-HD-Achernar",
      model: "chirp",
      encoding: "MP3",
      speed: 1,
      pitch: 0,
      volumeGainDb: 0,
      credentials: { apiKey: "key" },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.input.ssml).toBeUndefined();
    expect(body.input.text).toBe("Hi there");
  });

  it("gates speed on non-Gemini voices via the predicate", () => {
    const geminiVoice = {
      id: "Achernar",
      providerId: "google" as const,
      displayName: "Achernar",
      languageCodes: ["en-US"],
      gender: "Neutral",
      models: ["gemini"],
    };
    expect(google.supportsSpeed(geminiVoice, "gemini")).toBe(false);
    expect(google.supportsSpeed(undefined, "gemini")).toBe(false);
    expect(google.supportsSpeed(undefined, "wavenet")).toBe(true);
    expect(google.supportsSpeed(undefined, "chirp")).toBe(true);
  });
});

describe("openai provider (REST)", () => {
  it("ships a static multilingual voice catalog", async () => {
    const voices = await openai.fetchVoices({ apiKey: "sk" });
    expect(voices.length).toBeGreaterThan(5);
    expect(voices.every((v) => v.providerId === "openai")).toBe(true);
    expect(voices.every((v) => v.languageCodes.includes("multilingual"))).toBe(true);
  });

  it("is speed-only: no pitch, volume, style, or SSML", () => {
    expect(openai.supportsSpeed(undefined, "tts-1")).toBe(true);
    expect(openai.supportsSpeed(undefined, "gpt-4o-mini-tts")).toBe(true);
    expect(openai.supportsPitch(undefined, "tts-1")).toBe(false);
    expect(openai.supportsVolume(undefined, "tts-1")).toBe(false);
    expect(openai.supportsStyle(undefined, "tts-1")).toBe(false);
    expect(openai.supportsSSML(undefined, "tts-1")).toBe(false);
  });

  it("strips SSML markup before sending plain-text input", async () => {
    const audio = new TextEncoder().encode("mp3data").buffer;
    const fetchMock = mockFetchOnce(audio, true, true);
    await openai.synthesize({
      text: "<speak>Hi <break/> there</speak>",
      voiceId: "nova",
      model: "tts-1",
      encoding: "MP3",
      speed: 1,
      pitch: 0,
      volumeGainDb: 0,
      credentials: { apiKey: "sk" },
    });
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.input).toBe("Hi there");
  });

  it("falls back to MP3 when a multi-chunk request asked for non-stitchable Opus", async () => {
    const audio = new TextEncoder().encode("audio").buffer;
    const fetchMock = mockFetchOnce(audio, true, true);
    // Two sentences, each within the limit but jointly above it → two chunks.
    const sentence = `${"word ".repeat(700)}end.`;
    const result = await openai.synthesize({
      text: `${sentence} ${sentence}`,
      voiceId: "nova",
      model: "tts-1",
      encoding: "OGG_OPUS",
      speed: 1,
      pitch: 0,
      volumeGainDb: 0,
      credentials: { apiKey: "sk" },
    });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    // Concatenated Ogg streams play badly, so the effective format must be MP3.
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.extension).toBe("mp3");
    for (const call of fetchMock.mock.calls) {
      const [, init] = call as [string, RequestInit];
      expect(JSON.parse(String(init.body)).response_format).toBe("mp3");
    }
  });

  it("keeps the requested Opus format for a single-chunk request", async () => {
    const audio = new TextEncoder().encode("audio").buffer;
    mockFetchOnce(audio, true, true);
    const result = await openai.synthesize({
      text: "Hello.",
      voiceId: "nova",
      model: "tts-1",
      encoding: "OGG_OPUS",
      speed: 1,
      pitch: 0,
      volumeGainDb: 0,
      credentials: { apiKey: "sk" },
    });
    expect(result.mimeType).toBe("audio/ogg");
    expect(result.extension).toBe("ogg");
  });

  it("synthesizes with Bearer auth and returns raw bytes", async () => {
    const audio = new TextEncoder().encode("mp3data").buffer;
    const fetchMock = mockFetchOnce(audio, true, true);

    const result = await openai.synthesize({
      text: "Hello.",
      voiceId: "nova",
      model: "gpt-4o-mini-tts",
      encoding: "MP3",
      speed: 1,
      pitch: 0,
      volumeGainDb: 0,
      credentials: { apiKey: "sk-test" },
    });

    expect(new TextDecoder().decode(result.bytes)).toBe("mp3data");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/audio/speech");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("gpt-4o-mini-tts");
    expect(body.voice).toBe("nova");
  });

  it("validates credentials via the speech endpoint and returns voices", async () => {
    mockFetchOnce({}, true);
    expect((await openai.validateAndFetchVoices({ apiKey: "sk" })).length).toBeGreaterThan(5);
    mockFetchOnce({}, false);
    await expect(openai.validateAndFetchVoices({ apiKey: "bad" })).rejects.toThrow(/403/);
  });
});
