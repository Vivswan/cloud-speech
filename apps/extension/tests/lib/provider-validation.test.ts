import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "@/lib/provider-http";
import {
  classifyValidationError,
  sanitizeDetail,
  sanitizeValidationDetail,
  type ValidationFailureCode,
  validateProviderCandidate,
} from "@/lib/provider-validation";
import { SlotAbortError } from "@/lib/slot";
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

  it("reports persistence failures separately after successful validation", async () => {
    const result = await validateProviderCandidate(
      providerWith(async () => VOICES),
      CREDENTIALS,
      async () => {
        throw new Error("storage quota exceeded");
      },
    );

    expect(result).toMatchObject({ ok: false, code: "storage" });
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

  it("scans a body padded with whitespace in linear time", () => {
    const padded = `upstream error\n${" ".repeat(64_000)}timeout`;
    const started = performance.now();
    expect(sanitizeDetail(padded, server("different-key"))).toBe(padded);
    expect(performance.now() - started).toBeLessThan(200);
  });

  // One rule's match must never cut another's in two and leave a fragment:
  // every span is found on the intact text, then overlapping spans merge.
  it.each([
    {
      overlap: "a configured value inside a longer configured value of another provider",
      text: "Invalid credential EXAMPLEKEY0us-east-1EXAMPLEOPAQUE00000000000000",
      apiKey: "EXAMPLEKEY0us-east-1EXAMPLEOPAQUE00000000000000",
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
