import { afterEach, describe, expect, it, vi } from "vitest";
import { SlotAbortError } from "@/lib/slot";
import { azure, endpoint } from "@/providers/azure";
import { synthArgs } from "../helpers/synth-args";

// The Azure REST transport: request shape, voice normalization, and error
// handling, with fetch mocked.

const CREDS = { subscriptionKey: "k", region: "eastus" };

/** One `/voices/list` entry as the service returns it. */
function voiceEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Name: "Microsoft Server Speech Text to Speech Voice (en-US, JennyNeural)",
    DisplayName: "Jenny",
    LocalName: "Jenny",
    ShortName: "en-US-JennyNeural",
    Gender: "Female",
    Locale: "en-US",
    LocaleName: "English (United States)",
    StyleList: ["cheerful", "sad"],
    SampleRateHertz: "48000",
    VoiceType: "Neural",
    Status: "GA",
    WordsPerMinute: "152",
    ...overrides,
  };
}

function mockFetch(response: {
  ok: boolean;
  status?: number;
  body?: string;
  bytes?: Uint8Array;
  contentType?: string;
}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status ?? (response.ok ? 200 : 500),
    headers: new Headers({ "content-type": response.contentType ?? "audio/mpeg" }),
    text: () => Promise.resolve(response.body ?? ""),
    json: () => Promise.resolve(JSON.parse(response.body ?? "null")),
    arrayBuffer: () => Promise.resolve((response.bytes ?? new Uint8Array()).buffer),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("azure synthesize (REST)", () => {
  it("posts the SSML with key, content type, output format, and the caller's signal", async () => {
    const fetchMock = mockFetch({ ok: true, bytes: new Uint8Array([9, 8]) });
    const signal = new AbortController().signal;

    const result = await azure.synthesize(
      synthArgs({
        text: "Hello there.",
        voiceId: "en-US-JennyNeural",
        model: "neural",
        encoding: "OGG_OPUS",
        speed: 1.5,
        credentials: CREDS,
        signal,
      }),
    );

    expect(result).toEqual({
      bytes: new Uint8Array([9, 8]),
      mimeType: "audio/ogg",
      extension: "ogg",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/v1");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "Ocp-Apim-Subscription-Key": "k",
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": "ogg-16khz-16bit-mono-opus",
    });
    expect(init.signal).toBe(signal);
    expect(String(init.body)).toBe(
      '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ' +
        'xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="en-US">' +
        '<voice name="en-US-JennyNeural"><prosody rate="+50%">Hello there.</prosody></voice></speak>',
    );
  });

  it("falls back to 64 kbps MP3 across chunks when Opus was asked for multi-chunk text", async () => {
    const fetchMock = mockFetch({ ok: true, bytes: new Uint8Array([1]) });
    const sentence = `${"word ".repeat(900)}end.`;
    const result = await azure.synthesize(
      synthArgs({
        text: `${sentence} ${sentence}`,
        voiceId: "en-US-JennyNeural",
        encoding: "OGG_OPUS",
        credentials: CREDS,
      }),
    );
    expect(result).toMatchObject({ mimeType: "audio/mpeg", extension: "mp3" });
    expect([...result.bytes]).toEqual([1, 1]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      expect((init.headers as Record<string, string>)["X-Microsoft-OutputFormat"]).toBe(
        "audio-16khz-64kbitrate-mono-mp3",
      );
    }
  });

  const failures = [
    { status: 401, body: "" },
    { status: 429, body: "Rate limit is exceeded." },
    { status: 503, body: "<html>Service Unavailable</html>" },
  ];
  for (const { status, body } of failures) {
    it(`rejects an HTTP ${status} with a typed error carrying status and body`, async () => {
      mockFetch({ ok: false, status, body });
      await expect(
        azure.synthesize(synthArgs({ voiceId: "en-US-JennyNeural", credentials: CREDS })),
      ).rejects.toMatchObject({
        name: "ProviderHttpError",
        provider: "azure",
        operation: "synthesis",
        status,
        message: `Azure Speech synthesis failed: HTTP ${status}${body ? ` (${body})` : ""}`,
      });
    });
  }

  it("rejects a 2xx with an empty body as a synthesis failure, without a retry", async () => {
    const fetchMock = mockFetch({ ok: true, bytes: new Uint8Array(0) });
    await expect(
      azure.synthesize(synthArgs({ voiceId: "en-US-JennyNeural", credentials: CREDS })),
    ).rejects.toMatchObject({
      name: "ProviderHttpError",
      provider: "azure",
      operation: "synthesis",
      status: 200,
      message: "Azure Speech synthesis failed: HTTP 200 (no audio in the response)",
    });
    // A 200 is not the service's trouble: the answer is final, not transient.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a JSON envelope", "application/json", '{"error":{"message":"nope"}}', "nope"],
    ["an HTML page", "text/html", "<html>login</html>", "<html>login</html>"],
    // Nothing to quote: the answer still had no audio, so say that.
    ["an empty JSON body", "application/json", "", "no audio in the response"],
  ])("rejects a 2xx with %s in place of audio, detailed", async (_, contentType, body, detail) => {
    mockFetch({ ok: true, contentType, body });
    await expect(
      azure.synthesize(synthArgs({ voiceId: "en-US-JennyNeural", credentials: CREDS })),
    ).rejects.toMatchObject({
      name: "ProviderHttpError",
      status: 200,
      message: `Azure Speech synthesis failed: HTTP 200 (${detail})`,
    });
  });

  it("rejects with the caller's abort reason when cancelled mid-request", async () => {
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const reason = new SlotAbortError("superseded");

    const pending = azure.synthesize(
      synthArgs({ voiceId: "en-US-JennyNeural", credentials: CREDS, signal: controller.signal }),
    );
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
    expect((fetchMock.mock.calls[0] as [string, RequestInit])[1].signal).toBe(controller.signal);

    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
  });
});

describe("azure voices (REST)", () => {
  const methods = ["fetchVoices", "validateAndFetchVoices"] as const;
  for (const method of methods) {
    it(`${method} lists voices with the key header and the caller's signal, normalized like before`, async () => {
      const fetchMock = mockFetch({
        ok: true,
        body: JSON.stringify([
          voiceEntry(),
          voiceEntry({
            ShortName: "en-US-JennyMultilingualNeural",
            LocalName: "",
            Gender: "Female",
            SecondaryLocaleList: ["de-DE", "fr-FR"],
            StyleList: undefined,
          }),
          voiceEntry({
            ShortName: "de-DE-Hedda",
            LocalName: "Hedda",
            Locale: "de-DE",
            Gender: "Unknown",
            VoiceType: "Standard",
            StyleList: [],
          }),
        ]),
      });
      const signal = new AbortController().signal;

      const voices = await azure[method](CREDS, signal);

      expect(voices).toEqual([
        {
          id: "en-US-JennyNeural",
          providerId: "azure",
          displayName: "Jenny",
          languageCodes: ["en-US"],
          gender: "Female",
          models: ["neural"],
          styles: ["cheerful", "sad"],
        },
        {
          // No LocalName: the ShortName is the display name.
          id: "en-US-JennyMultilingualNeural",
          providerId: "azure",
          displayName: "en-US-JennyMultilingualNeural",
          languageCodes: ["en-US"],
          gender: "Female",
          models: ["neural"],
          styles: [],
        },
        {
          id: "de-DE-Hedda",
          providerId: "azure",
          displayName: "Hedda",
          languageCodes: ["de-DE"],
          gender: "Neutral",
          models: ["standard"],
          styles: [],
        },
      ]);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list");
      expect(init.headers).toEqual({ "Ocp-Apim-Subscription-Key": "k" });
      expect(init.signal).toBe(signal);
    });
  }

  it("rejects a 401 with a typed error and an empty list as an error", async () => {
    mockFetch({ ok: false, status: 401 });
    await expect(azure.fetchVoices(CREDS)).rejects.toMatchObject({
      name: "ProviderHttpError",
      provider: "azure",
      operation: "voices",
      status: 401,
      message: "Azure Speech voices failed: HTTP 401",
    });

    mockFetch({ ok: true, body: "[]" });
    await expect(azure.fetchVoices(CREDS)).rejects.toThrow(/No voices returned/);
  });
});

describe("azure region check", () => {
  const clouds = [
    { region: "eastus", host: "eastus.tts.speech.microsoft.com" },
    { region: "westeurope", host: "westeurope.tts.speech.microsoft.com" },
    // Sovereign clouds, as the Speech SDK resolved them.
    { region: "chinaeast2", host: "chinaeast2.tts.speech.azure.cn" },
    { region: "usgovvirginia", host: "usgovvirginia.tts.speech.azure.us" },
    { region: "USGovArizona", host: "USGovArizona.tts.speech.azure.us" },
  ];
  for (const { region, host } of clouds) {
    it(`routes region ${region} to ${host}`, () => {
      expect(endpoint({ region })).toBe(`https://${host}/cognitiveservices`);
    });
  }

  const regions = [
    { region: "", message: "Azure region is missing" },
    { region: "  ", message: "Azure region is missing" },
    { region: "East US", message: 'Azure region "East US" is invalid' },
    { region: "-eastus", message: 'Azure region "-eastus" is invalid' },
    { region: "eastus-", message: 'Azure region "eastus-" is invalid' },
    { region: "a".repeat(64), message: `Azure region "${"a".repeat(64)}" is invalid` },
  ];
  for (const { region, message } of regions) {
    it(`rejects region ${JSON.stringify(region)} before any request`, async () => {
      const fetchMock = mockFetch({ ok: true, body: "[]" });
      const credentials = { subscriptionKey: "k", region };
      await expect(azure.fetchVoices(credentials)).rejects.toThrow(message);
      await expect(
        azure.synthesize(synthArgs({ voiceId: "en-US-JennyNeural", credentials })),
      ).rejects.toThrow(message);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
});
