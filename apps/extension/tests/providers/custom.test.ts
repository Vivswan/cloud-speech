import { afterEach, describe, expect, it, vi } from "vitest";
import { custom, normalizeBaseUrl, parseCsvList, parseModelsList } from "@/providers/custom";
import { hasAllCredentialFields } from "@/providers/types";

function mockFetchOnce(response: unknown, ok = true, status?: number) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok,
    status: status ?? (ok ? 200 : 403),
    headers: new Headers({ "content-type": "audio/mpeg" }),
    json: () => Promise.resolve(response),
    text: () => Promise.resolve(typeof response === "string" ? response : ""),
    arrayBuffer: () => Promise.resolve(response as ArrayBuffer),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const CREDS = { baseUrl: "http://localhost:4000/v1", apiKey: "sk-1234" };

describe("custom provider helpers", () => {
  it("normalizes trailing slashes off the base URL", () => {
    expect(normalizeBaseUrl("http://localhost:4000/v1/")).toBe("http://localhost:4000/v1");
    expect(normalizeBaseUrl("http://localhost:4000/v1//")).toBe("http://localhost:4000/v1");
    expect(normalizeBaseUrl("  http://x/v1  ")).toBe("http://x/v1");
  });

  it("drops query strings and fragments — auth belongs in the key field", () => {
    expect(normalizeBaseUrl("https://host/v1?token=x")).toBe("https://host/v1");
    expect(normalizeBaseUrl("https://host/v1#frag")).toBe("https://host/v1");
    expect(normalizeBaseUrl("not a url/v1?x=1")).toBe("not a url/v1");
  });

  it("parses the comma-separated voices credential", () => {
    expect(parseCsvList("af_bella, am_adam ,, alloy ")).toEqual(["af_bella", "am_adam", "alloy"]);
    expect(parseCsvList(undefined)).toEqual([]);
    expect(parseCsvList("  ")).toEqual([]);
  });

  it("dedupes repeated names — they would collide as picker row keys", () => {
    expect(parseCsvList("alloy, af_bella, alloy")).toEqual(["alloy", "af_bella"]);
  });
});

describe("custom provider credentials", () => {
  it("requires only the base URL — key, voices, and model are optional", () => {
    expect(custom.hasCredentials({ baseUrl: "http://localhost:8880/v1" })).toBe(true);
    expect(custom.hasCredentials({ apiKey: "sk-x" })).toBe(false);
    expect(custom.hasCredentials({})).toBe(false);
    expect(custom.hasCredentials(undefined)).toBe(false);
  });

  it("hasAllCredentialFields honors the optional flag", () => {
    const schema = [
      { key: "a", labelKey: "x", placeholder: "", type: "text" as const },
      { key: "b", labelKey: "y", placeholder: "", type: "text" as const, optional: true },
    ];
    expect(hasAllCredentialFields(schema, { a: "v" })).toBe(true);
    expect(hasAllCredentialFields(schema, { b: "v" })).toBe(false);
    expect(hasAllCredentialFields(schema, { a: "v", b: "v" })).toBe(true);
  });

  it("validates against the speech endpoint without an Authorization header when keyless", async () => {
    const fetchMock = mockFetchOnce(new ArrayBuffer(1));
    const ok = await custom.validateCredentials({ baseUrl: "http://localhost:8880/v1/" });
    expect(ok).toBe(true);
    // Discovery may run first — assert on the speech probe specifically.
    const speechCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/audio/speech"),
    ) as [string, RequestInit];
    expect(speechCall[0]).toBe("http://localhost:8880/v1/audio/speech");
    expect((speechCall[1].headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("probes validation with a DISCOVERED voice, not a hardcoded one", async () => {
    // A Kokoro-style server that only knows af_* names would reject "alloy".
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      if (String(url).endsWith("/audio/voices")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ voices: ["af_bella"] }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "audio/mpeg" }),
        arrayBuffer: () => Promise.resolve(new ArrayBuffer(1)),
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    expect(await custom.validateCredentials({ baseUrl: "http://box:8880/v1" })).toBe(true);
    const speechCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/audio/speech"),
    ) as [string, RequestInit];
    expect(JSON.parse(String(speechCall[1].body)).voice).toBe("af_bella");
  });

  it("sends a Bearer header when a key is configured", async () => {
    const fetchMock = mockFetchOnce(new ArrayBuffer(1));
    await custom.validateCredentials(CREDS);
    const speechCall = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith("/audio/speech"),
    ) as [string, RequestInit];
    expect((speechCall[1].headers as Record<string, string>).Authorization).toBe("Bearer sk-1234");
  });

  it("rejects a 2xx validation response that is not audio", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ "content-type": "text/html" }),
      arrayBuffer: () => Promise.resolve(new TextEncoder().encode("<html>catch-all").buffer),
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await custom.validateCredentials({ ...CREDS, voices: "alloy" })).toBe(false);
  });

  it("fails validation without a base URL and never fetches", async () => {
    const fetchMock = mockFetchOnce(new ArrayBuffer(1));
    expect(await custom.validateCredentials({ apiKey: "sk-x" })).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("custom provider voices", () => {
  it("prefers the user's explicit voice list and never fetches for it", async () => {
    const fetchMock = mockFetchOnce({ voices: ["server_voice"] });
    const voices = await custom.fetchVoices({ ...CREDS, voices: "af_bella, am_adam" });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(voices.map((v) => v.id)).toEqual(["af_bella", "am_adam"]);
    expect(voices[0]?.providerId).toBe("custom");
    expect(voices[0]?.models).toEqual(["tts-1"]);
  });

  it("gives every voice one picker row per listed model", async () => {
    expect(parseModelsList("kokoro, tts-1 ,")).toEqual(["kokoro", "tts-1"]);
    expect(parseModelsList(undefined)).toEqual(["tts-1"]);
    const voices = await custom.fetchVoices({ ...CREDS, voices: "a", model: "kokoro, tts-1" });
    expect(voices[0]?.models).toEqual(["kokoro", "tts-1"]);
  });

  it("discovers voices from GET /audio/voices when no list is configured", async () => {
    const fetchMock = mockFetchOnce({ voices: ["af_bella", "af_sky"] });
    const voices = await custom.fetchVoices({ ...CREDS, model: "kokoro" });
    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe("http://localhost:4000/v1/audio/voices");
    expect(voices.map((v) => v.id)).toEqual(["af_bella", "af_sky"]);
    // The configured model becomes each voice's engine.
    expect(voices[0]?.models).toEqual(["kokoro"]);
  });

  it("falls back to the OpenAI voice names when the server lacks discovery (404)", async () => {
    mockFetchOnce("not found", false, 404);
    const voices = await custom.fetchVoices(CREDS);
    expect(voices.map((v) => v.id)).toContain("alloy");
    expect(voices.length).toBeGreaterThan(5);
  });

  it("falls back when the 200 discovery body is not JSON", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new SyntaxError("Unexpected token <")),
      }),
    );
    const voices = await custom.fetchVoices(CREDS);
    expect(voices.map((v) => v.id)).toContain("alloy");
  });

  it("propagates transient discovery failures so cached voices survive", async () => {
    // lib/voices.ts keeps the last-good cache only when fetchVoices REJECTS;
    // fulfilling with the alias names would silently replace real voices.
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection refused")));
    await expect(custom.fetchVoices(CREDS)).rejects.toThrow(/connection refused/);

    mockFetchOnce("boom", false, 503);
    await expect(custom.fetchVoices(CREDS)).rejects.toThrow(/503/);

    // Auth and rate-limit trouble is not "endpoint unsupported" either.
    mockFetchOnce("nope", false, 401);
    await expect(custom.fetchVoices(CREDS)).rejects.toThrow(/401/);

    // A body read that dies mid-stream after a 200 is just as transient.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: () => Promise.reject(new TypeError("network error")),
      }),
    );
    await expect(custom.fetchVoices(CREDS)).rejects.toThrow(/network error/);
  });
});

describe("custom provider synthesis", () => {
  const args = {
    text: "Hello there.",
    voiceId: "af_bella",
    model: "kokoro",
    encoding: "MP3",
    speed: 1.5,
    pitch: 0,
    volumeGainDb: 0,
  };

  it("posts to the configured base URL with model, voice, and speed", async () => {
    const audio = new TextEncoder().encode("mp3").buffer;
    const fetchMock = mockFetchOnce(audio);
    await custom.synthesize({ ...args, credentials: { baseUrl: "http://box:8880/v1/" } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://box:8880/v1/audio/speech");
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: "kokoro", voice: "af_bella", speed: 1.5 });
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  it("throws without a configured base URL", async () => {
    await expect(custom.synthesize({ ...args, credentials: {} })).rejects.toThrow(/No server URL/);
  });

  it("surfaces the server's error body in synthesis failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        text: () => Promise.resolve('{"error":"unknown voice af_x"}'),
      }),
    );
    await expect(custom.synthesize({ ...args, credentials: CREDS })).rejects.toThrow(
      /400.*unknown voice af_x/,
    );
  });

  it("rejects a 2xx synthesis response that carries JSON instead of audio", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ "content-type": "application/json" }),
        text: () => Promise.resolve('{"error":"quota exceeded"}'),
      }),
    );
    await expect(custom.synthesize({ ...args, credentials: CREDS })).rejects.toThrow(
      /quota exceeded/,
    );
  });

  it("rejects an empty 2xx synthesis response instead of playing silence", async () => {
    mockFetchOnce(new ArrayBuffer(0));
    await expect(custom.synthesize({ ...args, credentials: CREDS })).rejects.toThrow(
      /empty response/,
    );
  });

  it("falls back to MP3 when a multi-chunk request asked for non-stitchable Opus", async () => {
    const audio = new TextEncoder().encode("audio").buffer;
    const fetchMock = mockFetchOnce(audio);
    const sentence = `${"word ".repeat(700)}end.`;
    const result = await custom.synthesize({
      ...args,
      text: `${sentence} ${sentence}`,
      encoding: "OGG_OPUS",
      credentials: CREDS,
    });
    expect(result.extension).toBe("mp3");
    for (const call of fetchMock.mock.calls) {
      const body = JSON.parse(String((call[1] as RequestInit).body));
      expect(body.response_format).toBe("mp3");
    }
  });
});
