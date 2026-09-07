import { describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "@/lib/provider-http";
import {
  classifyValidationError,
  sanitizeValidationDetail,
  type ValidationFailureCode,
  validateProviderCandidate,
} from "@/lib/provider-validation";
import { SlotAbortError } from "@/lib/slot";
import { polly } from "@/providers/polly";
import type { NormalizedVoice, TtsProvider } from "@/providers/types";

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

    expect(result).toEqual({ ok: false, code: "unknown", detail: "superseded" });
    expect(commit).not.toHaveBeenCalled();
  });

  it("reports a commit refused as stale as superseded, never as success", async () => {
    const result = await validateProviderCandidate(
      providerWith(async () => VOICES),
      CREDENTIALS,
      async () => "superseded",
    );

    expect(result).toEqual({ ok: false, code: "unknown", detail: "superseded" });
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
