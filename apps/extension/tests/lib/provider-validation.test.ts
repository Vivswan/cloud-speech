import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "@/lib/provider-http";
import {
  classifyValidationError,
  occurrences,
  redactCredentials,
  sanitizeDetail,
  sanitizeValidationDetail,
  type ValidationFailureCode,
  validateProviderCandidate,
} from "@/lib/provider-validation";
import { SlotAbortError } from "@/lib/slot";
import { SETTINGS_VERSION } from "@/lib/storage";
import { SettingsNewerError } from "@/migrations";
import { custom } from "@/providers/custom";
import { polly } from "@/providers/polly";
import type { NormalizedVoice, TtsProvider } from "@/providers/types";
import { sdkError } from "../helpers/sdk-error";

const VOICES: NormalizedVoice[] = [
  {
    id: "Joanna",
    providerId: "polly",
    displayName: "Joanna",
    languageCodes: ["en-US"],
    gender: "Female",
    models: ["standard"],
  },
];

const CREDENTIALS = {
  accessKeyId: "AKIAEXAMPLE00000000",
  secretAccessKey: "example-secret-value-with-many-characters",
  region: "us-east-1",
};

function providerWith(validateAndFetchVoices: TtsProvider["validateAndFetchVoices"]): TtsProvider {
  return { ...polly, validateAndFetchVoices };
}

describe("validateProviderCandidate", () => {
  it("calls the provider once with the caller's signal and commits the fresh voices", async () => {
    const validate = vi.fn(
      async (_credentials: Record<string, string>, _signal?: AbortSignal) => VOICES,
    );
    const commit = vi.fn(async (_voices: NormalizedVoice[]) => "persisted" as const);
    const signal = new AbortController().signal;

    const result = await validateProviderCandidate(
      providerWith(validate),
      CREDENTIALS,
      commit,
      signal,
    );

    expect(result).toEqual({ ok: true });
    expect(validate).toHaveBeenCalledTimes(1);
    // The same signal object reaches the provider, so a newer Save & test can
    // cancel this request mid-flight.
    expect(validate).toHaveBeenCalledWith(CREDENTIALS, signal);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(VOICES);
  });

  it("reports a cancelled provider request as superseded, not as a provider failure", async () => {
    const commit = vi.fn(async (_voices: NormalizedVoice[]) => "persisted" as const);
    const result = await validateProviderCandidate(
      providerWith(async () => {
        throw new SlotAbortError("superseded");
      }),
      CREDENTIALS,
      commit,
    );

    expect(result).toEqual({ ok: false, code: "superseded" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("reports a commit refused as stale as superseded, never as success", async () => {
    const result = await validateProviderCandidate(
      providerWith(async () => VOICES),
      CREDENTIALS,
      async () => "superseded",
    );

    expect(result).toEqual({ ok: false, code: "superseded" });
  });

  it("does not commit or replace working credentials after provider failure", async () => {
    const error = Object.assign(new Error("The security token is invalid"), {
      name: "InvalidClientTokenId",
    });
    Reflect.set(error, "$metadata", { httpStatusCode: 403 });
    const validate = vi.fn(async () => {
      throw error;
    });
    let storedAccessKey = "working-key";
    const commit = vi.fn(async (_voices: NormalizedVoice[]) => {
      storedAccessKey = CREDENTIALS.accessKeyId;
      return "persisted" as const;
    });

    const result = await validateProviderCandidate(providerWith(validate), CREDENTIALS, commit);

    expect(result).toMatchObject({ ok: false, code: "authentication" });
    expect(commit).not.toHaveBeenCalled();
    expect(storedAccessKey).toBe("working-key");
  });

  it("reports persistence failures separately after successful validation, with the refused write's text", async () => {
    const result = await validateProviderCandidate(
      providerWith(async () => VOICES),
      CREDENTIALS,
      async () => {
        throw new Error("This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.");
      },
    );

    // The popup classifies the refused write (quota, write burst) from this
    // text, so it must arrive intact.
    expect(result).toEqual({
      ok: false,
      code: "storage",
      detail: "This request exceeds the MAX_WRITE_OPERATIONS_PER_MINUTE quota.",
    });
  });

  it("a write refused by settings a newer build saved names their version as a field, whatever redaction does to the text", async () => {
    // The configured key is a word of the error message, so the redacted
    // detail no longer reads as a SettingsNewerError.
    const credentials = { ...CREDENTIALS, secretAccessKey: "version" };
    const result = await validateProviderCandidate(
      providerWith(async () => VOICES),
      credentials,
      async () => {
        throw new SettingsNewerError(SETTINGS_VERSION + 1);
      },
    );

    expect(result).toMatchObject({
      ok: false,
      code: "storage",
      storedVersion: SETTINGS_VERSION + 1,
    });
    expect(result).not.toHaveProperty("storedVersion", undefined);
    if (result.ok) throw new Error("unreachable");
    expect(result.detail).toContain("[redacted]");
  });

  it("rejects an empty voice result without committing", async () => {
    const commit = vi.fn(async (_voices: NormalizedVoice[]) => "persisted" as const);
    const result = await validateProviderCandidate(
      providerWith(async () => []),
      CREDENTIALS,
      commit,
    );

    expect(result).toMatchObject({ ok: false, code: "unknown" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("rejects missing required fields before calling the provider", async () => {
    const validate = vi.fn(async () => VOICES);
    const commit = vi.fn(async (_voices: NormalizedVoice[]) => "persisted" as const);
    const result = await validateProviderCandidate(
      providerWith(validate),
      { accessKeyId: CREDENTIALS.accessKeyId, region: CREDENTIALS.region },
      commit,
    );

    expect(result).toEqual({
      ok: false,
      code: "authentication",
      detail: "Missing required field: secretAccessKey",
    });
    expect(validate).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  it("categorizes a missing region before calling the provider", async () => {
    const validate = vi.fn(async () => VOICES);
    const result = await validateProviderCandidate(
      providerWith(validate),
      {
        accessKeyId: CREDENTIALS.accessKeyId,
        secretAccessKey: CREDENTIALS.secretAccessKey,
      },
      async () => "persisted",
    );

    expect(result).toEqual({
      ok: false,
      code: "region",
      detail: "Missing required field: region",
    });
    expect(validate).not.toHaveBeenCalled();
  });

  it("reports a draft superseded before it started as superseded, even with missing fields", async () => {
    const controller = new AbortController();
    controller.abort(new SlotAbortError("superseded"));
    const validate = vi.fn(async () => VOICES);
    const commit = vi.fn(async (_voices: NormalizedVoice[]) => "persisted" as const);

    const result = await validateProviderCandidate(
      providerWith(validate),
      { accessKeyId: CREDENTIALS.accessKeyId, region: CREDENTIALS.region },
      commit,
      controller.signal,
    );

    expect(result).toEqual({ ok: false, code: "superseded" });
    expect(validate).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });
});

describe("validateProviderCandidate retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Jitter factor 1: the first backoff is exactly 500 ms.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it.each([
    {
      failure: "one throttled listing",
      error: sdkError("ThrottlingException", 400),
      calls: 2,
      result: { ok: true },
      committed: [VOICES],
    },
    {
      failure: "a rejected key",
      error: sdkError("InvalidClientTokenId", 403),
      calls: 1,
      result: { ok: false, code: "authentication" },
      committed: [],
    },
  ])("after $failure: $calls call(s), $result", async ({ error, calls, result, committed }) => {
    const validate = vi.fn(async () => VOICES).mockRejectedValueOnce(error);
    const commit = vi.fn(async (_voices: NormalizedVoice[]) => "persisted" as const);
    const signal = new AbortController().signal;

    const outcome = validateProviderCandidate(providerWith(validate), CREDENTIALS, commit, signal);
    await vi.advanceTimersByTimeAsync(500);

    expect(await outcome).toMatchObject(result);
    expect(validate.mock.calls).toEqual(Array(calls).fill([CREDENTIALS, signal]));
    expect(commit.mock.calls.map(([voices]) => voices)).toEqual(committed);
  });
});

describe("occurrences", () => {
  it.each([
    {
      text: "aaaa",
      value: "aa",
      spans: [
        [0, 2],
        [1, 3],
        [2, 4],
      ],
    },
    {
      text: "abababab",
      value: "abab",
      spans: [
        [0, 4],
        [2, 6],
        [4, 8],
      ],
    },
    { text: "abcabcabd", value: "abcabd", spans: [[3, 9]] },
    // At the "b" the match falls back twice (aaa -> aa -> a) before it fails.
    { text: "aaabaa", value: "aaa", spans: [[0, 3]] },
    { text: "key", value: "key", spans: [[0, 3]] },
    { text: "the key", value: "key", spans: [[4, 7]] },
    {
      text: "key, key",
      value: "key",
      spans: [
        [0, 3],
        [5, 8],
      ],
    },
    { text: "ke", value: "key", spans: [] },
    { text: "", value: "key", spans: [] },
    { text: "key", value: "", spans: [] },
    { text: "Key KEY", value: "key", spans: [] },
  ])("finds $value in $text at $spans", ({ text, value, spans }) => {
    expect(occurrences(text, value)).toEqual(spans);
  });

  it("spans code units, so a value after an astral character starts two units in", () => {
    expect(occurrences("\u{1F600}key", "key")).toEqual([[2, 5]]);
  });
});

describe("validation error classification", () => {
  const http = (status: number, message: string) => Object.assign(new Error(message), { status });
  const cases: Array<{ error: Error; code: ValidationFailureCode; detail: string }> = [
    { error: http(401, "invalid key"), code: "authentication", detail: "HTTP 401: invalid key" },
    { error: http(403, "access denied"), code: "permission", detail: "HTTP 403: access denied" },
    {
      error: new Error("invalid region for this endpoint"),
      code: "region",
      detail: "invalid region for this endpoint",
    },
    {
      error: new Error("Azure region is missing"),
      code: "region",
      detail: "Azure region is missing",
    },
    {
      error: new Error('Azure region "East US" is invalid'),
      code: "region",
      detail: 'Azure region "East US" is invalid',
    },
    { error: http(429, "too many requests"), code: "quota", detail: "HTTP 429: too many requests" },
    {
      error: new TypeError("Failed to fetch: WebSocket timed out"),
      code: "network",
      detail: "TypeError: Failed to fetch: WebSocket timed out",
    },
    {
      error: new Error("unexpected provider response"),
      code: "unknown",
      detail: "unexpected provider response",
    },
    // Typed REST errors carry their status structurally and their message is
    // the detail as is (no reconstructed "HTTP <status>:" prefix); the body
    // text keeps its precedence over the status, as for every other error.
    {
      error: new ProviderHttpError("azure", "voices", 401),
      code: "authentication",
      detail: "Azure Speech voices failed: HTTP 401",
    },
    {
      error: new ProviderHttpError("azure", "voices", 403, "<html>"),
      code: "permission",
      detail: "Azure Speech voices failed: HTTP 403 (<html>)",
    },
    // A quota notice the service sent behind a 200 classifies by its text.
    {
      error: new ProviderHttpError("openai", "validation", 200, "quota exceeded"),
      code: "quota",
      detail: "OpenAI validation failed: HTTP 200 (quota exceeded)",
    },
    {
      error: new ProviderHttpError("openai", "validation", 429),
      code: "quota",
      detail: "OpenAI validation failed: HTTP 429",
    },
    {
      error: new ProviderHttpError("google", "synthesis", 500, "backend"),
      code: "unknown",
      detail: "Google Cloud TTS synthesis failed: HTTP 500 (backend)",
    },
    {
      error: new ProviderHttpError("google", "voices", 403, "invalid API key"),
      code: "authentication",
      detail: "Google Cloud TTS voices failed: HTTP 403 (invalid API key)",
    },
    {
      error: new ProviderHttpError("azure", "synthesis", 401, "Rate limit is exceeded."),
      code: "quota",
      detail: "Azure Speech synthesis failed: HTTP 401 (Rate limit is exceeded.)",
    },
  ];

  for (const { error, code, detail } of cases) {
    it(`classifies "${error.message}" as ${code}`, () => {
      expect(classifyValidationError(error, polly, CREDENTIALS)).toEqual({
        ok: false,
        code,
        detail,
      });
    });
  }

  it("strips a URL's query even when the credential is that URL's prefix", () => {
    const credentials = { baseUrl: "https://tts.example/v1", apiKey: "" };
    const error = new Error(
      "request failed: https://tts.example/v1/audio/speech?access_token=short-lived-token#session",
    );

    expect(sanitizeValidationDetail(error, custom, credentials)).toBe(
      "request failed: [redacted]/audio/speech",
    );
  });

  // The URL grammar's authority: after any run of slashes (a backslash counts
  // as one), up to the next slash, `?` or `#`; the last `@` in it ends the
  // user info. A backslash in the path is not one.
  it.each([
    {
      url: "https://user:pass@proxy.example:8443/v1/voices?key=EXAMPLE1#top",
      shown: "https://proxy.example:8443/v1/voices",
    },
    {
      url: "https:///user:EXAMPLE1@proxy.example/v1?auth=EXAMPLE2",
      shown: "https:///proxy.example/v1",
    },
    {
      url: "https://proxy.example\\v1\\user@route.example/v2",
      shown: "https://proxy.example\\v1\\user@route.example/v2",
    },
  ])("strips the user info and query of $url, and keeps its origin and path", ({ url, shown }) => {
    expect(sanitizeDetail(`GET ${url} failed`, server("different-key"))).toBe(
      `GET ${shown} failed`,
    );
  });

  it("blanks a configured value that is itself a URL with a query, whole", () => {
    const apiKey = "https://private.example/access?auth=EXAMPLE1";
    const detail = sanitizeDetail(
      `Rejected credential ${apiKey} for https://api.example/voices?trace=EXAMPLE2`,
      server(apiKey),
    );

    expect(detail).toBe("Rejected credential [redacted] for https://api.example/voices");
    expect(detail).not.toContain("private.example");
  });

  it("drops a configured value wholly inside a URL's query with the query, without a mark", () => {
    expect(
      sanitizeDetail("see https://console.example/o?key=EXAMPLEKEY0 now", server("EXAMPLEKEY0")),
    ).toBe("see https://console.example/o now");
  });

  // Dropping a URL's user info or query joins the text on both sides, which
  // can rebuild a configured value that never stood whole in the intact text
  // (a base URL around the user info a proxy added). The value search runs
  // again on the result. redactCredentials drops nothing, so it sees no
  // rebuilt value and keeps the text as typed.
  it.each([
    {
      rebuilt: "a base URL around the user info",
      text: "GET https://user:pass@private.example/access failed",
      apiKey: "https://private.example/access",
      shown: "GET [redacted] failed",
    },
    {
      rebuilt: "a key URL around a user info that is itself a key",
      text: "https://EXAMPLEKEY0@h.example/EXAMPLEKEY1 x",
      apiKey: "https://h.example/EXAMPLEKEY1",
      shown: "[redacted] x",
    },
    {
      rebuilt: "a value spanning the dropped query and the text after it",
      text: "https://u:p@h.example/a?q tail",
      apiKey: "https://h.example/a tail",
      shown: "[redacted]",
    },
    {
      rebuilt: "a value across a dropped query alone",
      text: "see https://h.example/a?q tail",
      apiKey: "https://h.example/a tail",
      shown: "see [redacted]",
    },
    {
      rebuilt: "a value across a dropped fragment alone",
      text: "see https://h.example/a#f tail",
      apiKey: "https://h.example/a tail",
      shown: "see [redacted]",
    },
    {
      rebuilt: "a value across a query ended by a parenthesis",
      text: "(see https://h.example/a?q) tail",
      apiKey: "https://h.example/a) tail",
      shown: "(see [redacted]",
    },
  ])("blanks $rebuilt, rebuilt by a drop, whole", ({ text, apiKey, shown }) => {
    expect(sanitizeDetail(text, server(apiKey))).toBe(shown);
    expect(redactCredentials(text, server(apiKey))).toBe(text);
  });

  // No rule reads a rendered mark: a value that is part of the word
  // "redacted" must not find itself inside "[redacted]".
  it("never blanks inside a mark", () => {
    expect(sanitizeDetail("token=example", server("redact"))).toBe("token=[redacted]");
    expect(redactCredentials("[redacted] redact", server("redact"))).toBe(
      "[[redacted]ed] [redacted]",
    );
  });

  // A short value's neighbours are what the user will read: a key character
  // that another blank or a drop takes away does not glue the value to it.
  it.each([
    {
      beside: "a longer configured value the drops rebuilt",
      text: "https://u:p@h.example/aabc",
      shown: "[redacted]",
    },
    {
      beside: "a longer configured value in the intact text",
      text: "Rejected https://h.example/aabc",
      shown: "Rejected [redacted]",
    },
    {
      beside: "an opaque token",
      text: `Rejected ${"x".repeat(40)}abc`,
      shown: "Rejected [redacted]",
    },
    {
      beside: "nothing, inside a dropped query that takes it",
      text: "see https://h.example/o?q=1abc",
      shown: "see https://h.example/o",
    },
    {
      beside: "an ordinary word, which keeps it",
      text: "Rejected xabc",
      shown: "Rejected xabc",
    },
  ])("blanks a short value beside $beside", ({ text, shown }) => {
    expect(
      sanitizeDetail(text, [[custom, { baseUrl: "https://h.example/a", apiKey: "abc" }]]),
    ).toBe(shown);
  });

  it("blanks the value of a label with a prefix (access_token) in a relative URL", () => {
    expect(
      sanitizeDetail(
        "request /audio/speech?access_token=EXAMPLE-short-lived-token failed",
        server("different-key"),
      ),
    ).toBe("request /audio/speech?access_token=[redacted] failed");
  });

  it("a labelled value in a quoted URL ends with the URL, keeping the closing quote", () => {
    expect(
      sanitizeDetail(
        'GET "https://h.example/a?access_token=EXAMPLE1" failed, Bearer EXAMPLE2" next',
        server("different-key"),
      ),
    ).toBe('GET "https://h.example/a" failed, Bearer [redacted]" next');
  });

  // A quoted value is blanked whole, quotes included; a quote inside an
  // unquoted value belongs to it, one that ends the value stays (above).
  it.each([
    { text: 'x-api-key="EXAMPLEKEY12345" rejected', shown: "x-api-key=[redacted] rejected" },
    {
      text: 'Authorization: Bearer "EXAMPLEKEY12345"',
      shown: "Authorization: [redacted] [redacted]",
    },
    { text: 'token: "EXAMPLEKEY12345"', shown: "token: [redacted]" },
    { text: "secret: 'EXAMPLEKEY12345', next", shown: "secret: [redacted], next" },
    { text: "key=<EXAMPLEKEY12345>;", shown: "key=[redacted];" },
    { text: 'Invalid api_key: "sk-EXAMPLEKEY12345678"', shown: "Invalid api_key: [redacted]" },
    { text: 'token=EXAMPLE"KEY12345', shown: "token=[redacted]" },
    { text: 'Bearer EXAMPLE"KEY12345 x', shown: "Bearer [redacted] x" },
    // An escaped quote inside a quoted value does not close it.
    {
      text: `Invalid api_key: ${JSON.stringify('sk-EXAMPLE"KEY12345678')}`,
      shown: "Invalid api_key: [redacted]",
    },
    { text: String.raw`key=<sk-EXAMPLE\>KEY12345678> rejected`, shown: "key=[redacted] rejected" },
    // A quote followed by anything but key material ends the value: the
    // closing quote of a URL and the status after it stay.
    {
      text: 'GET "https://h.example/a?token=EXAMPLE1":403 Forbidden',
      shown: 'GET "https://h.example/a":403 Forbidden',
    },
    {
      text: '{"url":"https://h.example/a?token=EXAMPLE1"}',
      shown: '{"url":"https://h.example/a"}',
    },
    // An unclosed quote opens no value: the next label's value is still found.
    { text: 'key=" until secret="EXAMPLEKEY12345"', shown: 'key=" until secret=[redacted]' },
  ])("blanks the labelled value in $text whole", ({ text, shown }) => {
    expect(sanitizeDetail(text, server("different-key"))).toBe(shown);
  });

  it.each(["id_token", "refresh_token", "x-api-key", "client_secret", "API-KEY"])(
    "blanks the value after the label %s",
    (label) => {
      expect(sanitizeDetail(`${label}=EXAMPLE-value rest`, server("different-key"))).toBe(
        `${label}=[redacted] rest`,
      );
    },
  );

  const server = (apiKey: string) =>
    [[custom, { baseUrl: "https://tts.example/v1", apiKey }]] as const;

  it("blanks only the values of the provider's own fields, and no blank one", () => {
    expect(
      sanitizeDetail("Rejected us-east-1", [[custom, { apiKey: "", region: "us-east-1" }]]),
    ).toBe("Rejected us-east-1");
    expect(sanitizeDetail("Rejected credential abc", server("abc"))).toBe(
      "Rejected credential [redacted]",
    );
  });

  it("blanks a value under four characters as a whole token only", () => {
    expect(sanitizeDetail("key=abc; model abcdef, abc.", server("abc"))).toBe(
      "key=[redacted]; model abcdef, [redacted].",
    );
  });

  it("blanks a short value with regex characters as text, not as a pattern", () => {
    expect(sanitizeDetail("token a.b, not axb", server("a.b"))).toBe("token [redacted], not axb");
  });

  // A value echoed with its own prefix overlaps itself; the search must not
  // skip past the first match's end or the tail survives ("[redacted]AB").
  it.each([
    { apiKey: "ABAB", text: "ABABAB", shown: "[redacted]" },
    { apiKey: "aaaaaaaa", text: "token aaaaaaaaaa!", shown: "token [redacted]!" },
    { apiKey: "a.a", text: "Rejected credential a.a.a", shown: "Rejected credential [redacted]" },
  ])("blanks the self-overlapping $apiKey in $text whole", ({ apiKey, text, shown }) => {
    expect(sanitizeDetail(text, server(apiKey))).toBe(shown);
    expect(redactCredentials(text, server(apiKey))).toBe(shown);
  });

  it.each([
    { body: "whitespace", text: " ".repeat(64_000), apiKey: "different-key" },
    {
      body: "runs one short of an opaque token",
      text: `${"x".repeat(39)} `.repeat(1_600),
      apiKey: "different-key",
    },
    {
      body: "hyphenated runs, a word boundary at every other character",
      text: `${"x-".repeat(19)}x `.repeat(1_600),
      apiKey: "different-key",
    },
    {
      // Labels opening a quote that never closes: the scan for the close
      // must end at the next opener, not run to the end from every one.
      body: "labels opening an unclosed angle bracket",
      text: "key=<".repeat(12_800),
      apiKey: "different-key",
    },
    {
      // A long key echoed at every position of a longer run: each of its
      // overlapping occurrences costs its length, once, with no URL dropped.
      body: "one letter, holding a long configured value at every position",
      text: "a".repeat(131_072),
      apiKey: "a".repeat(4_096),
      shown: "[redacted]",
    },
    {
      // Thousands of URL drops beside thousands of one-character marks: the
      // marks a drop swallows must be found by walking both lists once.
      body: "URLs with user info and query beside dotted tokens",
      text: `${"ws://a@b?c ".repeat(2_909)}${". ".repeat(16_000)} `,
      apiKey: ".",
      shown: `${"ws://b ".repeat(2_909)}${"[redacted] ".repeat(16_000)} `,
    },
  ])("scans a body of $body in linear time", ({ text, apiKey, shown = text }) => {
    const started = performance.now();
    expect(sanitizeDetail(text, server(apiKey))).toBe(shown);
    expect(performance.now() - started).toBeLessThan(200);
  });

  // One rule's match must never cut another's in two and leave a fragment:
  // every span is found on the intact text, then overlapping spans merge.
  it.each([
    {
      // Under 40 characters: only the configured value itself blanks it, not
      // the opaque-token rule.
      overlap: "a configured value inside a longer configured value of another provider",
      text: "Invalid credential EXAMPLEKEY0us-east-1EXAMPLE00",
      apiKey: "EXAMPLEKEY0us-east-1EXAMPLE00",
      shown: "Invalid credential [redacted]",
    },
    {
      overlap: "a configured value inside a long opaque token that is not configured",
      text: "Invalid credential EXAMPLEKEY0us-east-1EXAMPLEOPAQUE00000000000000",
      apiKey: "different-key",
      shown: "Invalid credential [redacted]",
    },
    {
      overlap: "a key=value label inside a configured value",
      text: "Rejected credential prefix-token=upstream-private-value",
      apiKey: "prefix-token=upstream-private-value",
      shown: "Rejected credential [redacted]",
    },
    {
      overlap: "a short configured value that is itself a label",
      text: "api key=upstream-private-value",
      apiKey: "key",
      shown: "api [redacted]=[redacted]",
    },
    {
      // Blanking errs toward more: the label at the value's end also takes
      // the word after it, where keeping it could keep a labeled secret.
      overlap: "a configured value ending in a label, and the word after it",
      text: "Credential proxy-token= expired",
      apiKey: "proxy-token=",
      shown: "Credential [redacted] [redacted]",
    },
    {
      overlap: "a JWT-shaped value whose long segments are opaque tokens",
      text: `Invalid token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${"a".repeat(40)}.${"b".repeat(40)}`,
      apiKey: `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${"a".repeat(40)}.${"b".repeat(40)}`,
      shown: "Invalid token [redacted]",
    },
  ])("blanks $overlap whole", ({ text, apiKey, shown }) => {
    const detail = sanitizeDetail(text, [
      [polly, { accessKeyId: "", secretAccessKey: "", region: "us-east-1" }],
      ...server(apiKey),
    ]);
    expect(detail).toBe(shown);
  });

  it("redacts credential values, authorization data, and URL queries", () => {
    const error = new Error(
      `request failed for ${CREDENTIALS.accessKeyId} secret=${CREDENTIALS.secretAccessKey} ` +
        `region=${CREDENTIALS.region} Bearer bearer-token-value ` +
        "https://service.example/v1?token=private#fragment",
    );

    const detail = sanitizeValidationDetail(error, polly, CREDENTIALS);

    expect(detail).not.toContain(CREDENTIALS.accessKeyId);
    expect(detail).not.toContain(CREDENTIALS.secretAccessKey);
    expect(detail).not.toContain(CREDENTIALS.region);
    expect(detail).not.toContain("bearer-token-value");
    expect(detail).not.toContain("token=private");
    expect(detail).toContain("https://service.example/v1");
    expect(detail).toContain("[redacted]");
  });
});
