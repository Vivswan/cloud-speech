import { describe, expect, it, vi } from "vitest";
import {
  classifyValidationError,
  sanitizeValidationDetail,
  type ValidationFailureCode,
  validateProviderCandidate,
} from "@/lib/provider-validation";
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
  it("calls the provider once and commits the returned fresh voices", async () => {
    const validate = vi.fn(async () => VOICES);
    const commit = vi.fn(async (_voices: NormalizedVoice[]) => {});

    const result = await validateProviderCandidate(providerWith(validate), CREDENTIALS, commit);

    expect(result).toEqual({ ok: true });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(commit).toHaveBeenCalledWith(VOICES);
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
    const commit = vi.fn(async (_voices: NormalizedVoice[]) => {});
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
    const commit = vi.fn(async (_voices: NormalizedVoice[]) => {});
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
      async () => {},
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
  const cases: Array<{ error: Error; expected: ValidationFailureCode }> = [
    {
      error: Object.assign(new Error("invalid key"), { status: 401 }),
      expected: "authentication",
    },
    {
      error: Object.assign(new Error("access denied"), { status: 403 }),
      expected: "permission",
    },
    { error: new Error("invalid region for this endpoint"), expected: "region" },
    { error: new Error("throwIfNullOrWhitespace:region"), expected: "region" },
    {
      error: Object.assign(new Error("too many requests"), { status: 429 }),
      expected: "quota",
    },
    { error: new TypeError("Failed to fetch: WebSocket timed out"), expected: "network" },
    { error: new Error("unexpected provider response"), expected: "unknown" },
  ];

  for (const { error, expected } of cases) {
    it(`classifies ${expected} failures`, () => {
      expect(classifyValidationError(error, polly, CREDENTIALS).code).toBe(expected);
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
