import { PollyClient } from "@aws-sdk/client-polly";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { ProviderHttpError } from "@/lib/provider-http";
import { NEVER_ABORTS } from "@/lib/slot";
import { providerList } from "@/providers";
import { OPENAI_VOICE_NAMES } from "@/providers/openai-protocol";
import {
  type NormalizedVoice,
  NormalizedVoiceSchema,
  type SynthResult,
  type TtsProvider,
} from "@/providers/types";
import {
  bodyReadFailure,
  type FetchOutcome,
  fakeResponse,
  fetchOutcome,
  networkFailure,
  type ResponseSpec,
} from "../helpers/http-response";
import { sdkError } from "../helpers/sdk-error";
import { synthArgs } from "../helpers/synth-args";

// ---------------------------------------------------------------------------
// Every provider's response parsing against arbitrary answers from its
// service. Whatever comes back (any status, any body, a cut connection), a
// call must settle: with a well-formed result, or with a rejection of a kind
// the code chose to raise. A TypeError is a property read off a shape the
// code assumed; a non-Error is something `String(error)` cannot explain to
// the user; a hang is a spinner that never stops.
// ---------------------------------------------------------------------------

const CREDENTIALS: Record<string, Record<string, string>> = {
  polly: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-east-1" },
  azure: { subscriptionKey: "key", region: "eastus" },
  google: { apiKey: "AIzaKey" },
  openai: { apiKey: "sk-key" },
  // No `voices` list, so fetchVoices runs its discovery request.
  custom: { baseUrl: "http://localhost:4000/v1" },
};

/** Two sentences that only fit in separate chunks for every provider limit,
 *  so concurrent chunk requests and their assembly are exercised too. */
const LONG_TEXT = `${"word ".repeat(700)}end. ${"word ".repeat(700)}end.`;

type Operation = "synthesize" | "fetchVoices" | "validateAndFetchVoices";
const OPERATIONS: Operation[] = ["synthesize", "fetchVoices", "validateAndFetchVoices"];

// --- The AWS SDK side (Polly): arbitrary `send` outcomes ---------------------

type SdkOutcome =
  | { kind: "reject"; name: string; status: number }
  | { kind: "empty" }
  | { kind: "audio"; bytes: Uint8Array }
  | { kind: "voices"; voices: unknown[]; nextToken: string | undefined };

/** SDK response fields are typed strings the SDK's own deserializer already
 *  produced, so they vary in value and presence, not in type. */
const sdkField = fc.option(fc.string({ maxLength: 12 }), { nil: undefined });
const sdkOutcome: fc.Arbitrary<SdkOutcome> = fc.oneof(
  fc.record({
    kind: fc.constant("reject" as const),
    name: fc.constantFrom(
      "ThrottlingException",
      "ServiceUnavailableException",
      "InternalFailure",
      "AccessDeniedException",
      "UnrecognizedClientException",
      "InvalidSsmlException",
      "TextLengthExceededException",
      "NetworkingError",
    ),
    status: fc.constantFrom(400, 403, 429, 500, 503),
  }),
  fc.constant({ kind: "empty" as const }),
  fc.record({ kind: fc.constant("audio" as const), bytes: fc.uint8Array({ maxLength: 32 }) }),
  fc.record({
    kind: fc.constant("voices" as const),
    voices: fc.array(
      fc.record(
        {
          Id: sdkField,
          Gender: sdkField,
          LanguageCode: sdkField,
          SupportedEngines: fc.option(fc.array(fc.string({ maxLength: 10 })), { nil: undefined }),
        },
        { requiredKeys: [] },
      ),
      { maxLength: 3 },
    ),
    nextToken: fc.option(fc.string({ minLength: 1, maxLength: 8 }), { nil: undefined }),
  }),
);

/** Serve `outcomes` in order, repeating the last one; a page token is
 *  honored once so pagination is exercised without an endless list (a
 *  service that paginates forever is not a shape the code can settle). */
function serveSdk(outcomes: SdkOutcome[]): () => Promise<unknown> {
  let call = 0;
  return () => {
    const outcome = outcomes[Math.min(call, outcomes.length - 1)] as SdkOutcome;
    const first = call === 0;
    call++;
    switch (outcome.kind) {
      case "reject":
        return Promise.reject(sdkError(outcome.name, outcome.status));
      case "empty":
        return Promise.resolve({});
      case "audio":
        return Promise.resolve({
          AudioStream: { transformToByteArray: () => Promise.resolve(outcome.bytes) },
        });
      case "voices":
        return Promise.resolve({
          Voices: outcome.voices,
          NextToken: first ? outcome.nextToken : undefined,
        });
    }
  };
}

// --- The fetch side: arbitrary responses ---------------------------------------

/** Serve `outcomes` in order, repeating the last one. The injected failures
 *  are returned so the property can recognize them surfacing verbatim. */
function serveFetch(outcomes: FetchOutcome[]): {
  fetch: () => Promise<Response>;
  injected: Error[];
} {
  const injected: Error[] = [];
  let call = 0;
  return {
    injected,
    fetch: () => {
      const outcome = outcomes[Math.min(call++, outcomes.length - 1)] as FetchOutcome;
      if (outcome.kind === "networkFailure") {
        const failure = networkFailure();
        injected.push(failure);
        return Promise.reject(failure);
      }
      const failure = bodyReadFailure();
      injected.push(failure);
      return Promise.resolve(fakeResponse(outcome.spec, failure));
    },
  };
}

// --- Accepted answers: one request sequence per provider and operation -----------

type Outcome = SdkOutcome | FetchOutcome;

const utf8 = new TextEncoder();
/** The audio every accepted synthesis answer carries, so a resolved control
 *  can check the bytes came through, not just that some bytes did. */
const FIXTURE_BYTES = [1, 2, 3];
const AUDIO: ResponseSpec = {
  status: 200,
  contentType: "audio/mpeg",
  body: new Uint8Array(FIXTURE_BYTES),
  bodyReadFails: false,
};
const json = (value: unknown): ResponseSpec => ({
  status: 200,
  contentType: "application/json",
  body: utf8.encode(JSON.stringify(value)),
  bodyReadFails: false,
});
const AZURE_VOICES = json([{ ShortName: "en-US-JennyNeural", Locale: "en-US" }]);
const GOOGLE_VOICES = json({ voices: [{ name: "en-US-Wavenet-D", languageCodes: ["en-US"] }] });
const CUSTOM_VOICES = json({ voices: ["af_bella"] });

/** The responses, in request order, that make `operation` succeed for each
 *  fetch-based provider. Custom's validation runs voice discovery and then
 *  the speech probe, so it needs two. */
const ACCEPTED_FETCH: Record<string, Record<Operation, ResponseSpec[]>> = {
  azure: {
    synthesize: [AUDIO],
    fetchVoices: [AZURE_VOICES],
    validateAndFetchVoices: [AZURE_VOICES],
  },
  google: {
    synthesize: [json({ audioContent: btoa(String.fromCharCode(...FIXTURE_BYTES)) })],
    fetchVoices: [GOOGLE_VOICES],
    validateAndFetchVoices: [GOOGLE_VOICES],
  },
  openai: {
    synthesize: [AUDIO],
    // The voice list is static: no request, no response.
    fetchVoices: [],
    validateAndFetchVoices: [AUDIO],
  },
  custom: {
    synthesize: [AUDIO],
    fetchVoices: [CUSTOM_VOICES],
    validateAndFetchVoices: [CUSTOM_VOICES, AUDIO],
  },
};

const POLLY_VOICES: SdkOutcome = {
  kind: "voices",
  voices: [{ Id: "Joanna", LanguageCode: "en-US", Gender: "Female" }],
  nextToken: undefined,
};
const ACCEPTED_SDK: Record<Operation, SdkOutcome[]> = {
  synthesize: [{ kind: "audio", bytes: new Uint8Array(FIXTURE_BYTES) }],
  fetchVoices: [POLLY_VOICES],
  validateAndFetchVoices: [POLLY_VOICES],
};

/** The voice ids the accepted voice-list answers name, per provider; OpenAI
 *  has no voice-list request and yields its static catalog. */
const FIXTURE_VOICE_IDS: Record<string, readonly string[]> = {
  polly: ["Joanna"],
  azure: ["en-US-JennyNeural"],
  google: ["en-US-Wavenet-D"],
  openai: OPENAI_VOICE_NAMES,
  custom: ["af_bella"],
};

const SERVER_ERROR: FetchOutcome = {
  kind: "response",
  spec: { status: 500, contentType: null, body: new Uint8Array(0), bodyReadFails: false },
};
const SDK_SERVER_ERROR: SdkOutcome = { kind: "reject", name: "InternalFailure", status: 500 };

function accepted(provider: TtsProvider, operation: Operation): Outcome[] {
  if (provider.id === "polly") return ACCEPTED_SDK[operation];
  const sequence = ACCEPTED_FETCH[provider.id]?.[operation];
  if (!sequence) throw new Error(`no accepted response sequence for ${provider.id}`);
  return sequence.map((spec): FetchOutcome => ({ kind: "response", spec }));
}

/** A transient failure the retry policy absorbs. */
const transientFetch: fc.Arbitrary<Outcome> = fc
  .record({
    status: fc.constantFrom(429, 500, 503),
    contentType: fc.constant(null),
    body: fc.constant(new Uint8Array(0)),
    bodyReadFails: fc.constant(false),
  })
  .map((spec) => ({ kind: "response", spec }));
// Throttling is transient by name (its status is a 400); the others by status.
const transientSdk: fc.Arbitrary<Outcome> = fc.constantFrom<Outcome>(
  { kind: "reject", name: "ThrottlingException", status: 400 },
  { kind: "reject", name: "ServiceUnavailableException", status: 503 },
  { kind: "reject", name: "InternalFailure", status: 500 },
);

/** The accepted sequence for `operation`. Synthesis retries transient
 *  failures per chunk request, so half the time it starts with one; a voice
 *  list or validation request is never retried, so there a failure is final. */
function acceptedSequence(provider: TtsProvider, operation: Operation): fc.Arbitrary<Outcome[]> {
  const sequence = accepted(provider, operation);
  if (operation !== "synthesize") return fc.constant(sequence);
  const transient = provider.id === "polly" ? transientSdk : transientFetch;
  return fc
    .option(transient, { nil: undefined })
    .map((first) => (first === undefined ? sequence : [first, ...sequence]));
}

// --- The contract -------------------------------------------------------------------

type Settled = { status: "resolved"; value: unknown } | { status: "rejected"; error: unknown };

/** Await `promise` under fake timers, advancing them so the retry backoff
 *  (at most 500 + 1000 ms with jitter pinned) elapses at once. A promise still
 *  pending after far more than that is a hang. */
async function settle(promise: Promise<unknown>): Promise<Settled> {
  let settled: Settled | undefined;
  void promise.then(
    (value) => {
      settled = { status: "resolved", value };
    },
    (error: unknown) => {
      settled = { status: "rejected", error };
    },
  );
  for (let i = 0; i < 6 && settled === undefined; i++) {
    await vi.advanceTimersByTimeAsync(5_000);
  }
  if (settled === undefined) throw new Error("the call did not settle within 30s of fake time");
  return settled;
}

/** The rejections a provider is allowed to surface. Anything else is a defect:
 *  a TypeError or RangeError comes from code that assumed a shape, and a
 *  non-Error cannot be reported. */
function rejectionKind(error: unknown, injected: Error[]): string {
  if (injected.includes(error as Error)) return "network failure, verbatim";
  if (error instanceof ProviderHttpError) return "ProviderHttpError";
  if (error instanceof z.ZodError) return "ZodError at the response schema";
  if (error instanceof SyntaxError) return "SyntaxError from JSON.parse of a 2xx body";
  // happy-dom's atob throws its own DOMException class, not the global one.
  if (error instanceof Error && error.name === "InvalidCharacterError") {
    return "InvalidCharacterError from atob of a 2xx audioContent";
  }
  if (error instanceof Error && error.constructor === Error) return `Error: ${error.message}`;
  return `UNEXPECTED: ${Object.prototype.toString.call(error)} ${String(error)}`;
}

function checkResolved(operation: Operation, value: unknown): void {
  if (operation === "synthesize") {
    expect(value).toMatchObject({ mimeType: expect.any(String), extension: expect.any(String) });
    expect((value as { bytes: unknown }).bytes).toBeInstanceOf(Uint8Array);
    return;
  }
  expect(Array.isArray(value)).toBe(true);
  for (const voice of value as unknown[]) NormalizedVoiceSchema.parse(voice);
}

/** The accepted answer's values, not just its shape: the fixture bytes for
 *  a synthesis, the fixture's voice ids for a voice list. */
function expectFixtureResult(provider: TtsProvider, operation: Operation, value: unknown): void {
  if (operation === "synthesize") {
    expect(Array.from((value as SynthResult).bytes)).toEqual(FIXTURE_BYTES);
    return;
  }
  const ids = (value as NormalizedVoice[]).map((voice) => voice.id);
  expect(ids).toEqual(FIXTURE_VOICE_IDS[provider.id]);
}

function run(provider: TtsProvider, operation: Operation, long: boolean): Promise<unknown> {
  const credentials = CREDENTIALS[provider.id] as Record<string, string>;
  switch (operation) {
    case "synthesize":
      return provider.synthesize(
        synthArgs({
          text: long ? LONG_TEXT : "Hello there.",
          voiceId: provider.id === "azure" ? "en-US-JennyNeural" : "Joanna",
          model: provider.models[0].value,
          credentials,
          signal: NEVER_ABORTS,
        }),
      );
    case "fetchVoices":
      return provider.fetchVoices(credentials, NEVER_ABORTS);
    case "validateAndFetchVoices":
      return provider.validateAndFetchVoices(credentials, NEVER_ABORTS);
  }
}

let pollyRespond: () => Promise<unknown> = () => Promise.resolve({});

/** Point the provider's transport at `outcomes`: the spied SDK `send` for
 *  Polly, a stubbed `fetch` for the rest. Returns the network failures it
 *  injected (so the property can recognize them surfacing verbatim) and a
 *  request counter. */
function serve(
  provider: TtsProvider,
  outcomes: Outcome[],
): {
  injected: Error[];
  requests: () => number;
} {
  let requests = 0;
  if (provider.id === "polly") {
    const respond = serveSdk(outcomes as SdkOutcome[]);
    pollyRespond = () => {
      requests++;
      return respond();
    };
    return { injected: [], requests: () => requests };
  }
  const server = serveFetch(outcomes as FetchOutcome[]);
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      requests++;
      return server.fetch();
    }),
  );
  return { injected: server.injected, requests: () => requests };
}

beforeEach(() => {
  vi.useFakeTimers();
  // Jitter factor 1: the backoff is exactly 500 ms, then 1000 ms.
  vi.spyOn(Math, "random").mockReturnValue(0);
  // The Node http handler resolves the AWS defaults mode in its constructor;
  // "auto" (from the developer's env or ~/.aws/config) would probe IMDS.
  vi.stubEnv("AWS_DEFAULTS_MODE", "standard");
  vi.spyOn(PollyClient.prototype, "send").mockImplementation(() => pollyRespond());
  // Body-parse failures and rejected retries are logged on purpose.
  vi.spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe.each(providerList.map((provider) => ({ provider, id: provider.id })))(
  "$id under arbitrary service responses",
  ({ provider }) => {
    it.each(OPERATIONS.map((operation) => ({ operation })))(
      "$operation settles with a well-formed result or a rejection the code raises",
      async ({ operation }) => {
        // Mostly adversarial, salted with the accepted sequence so the success
        // path (and its result check) runs inside the property too.
        const adversarialOutcome: fc.Arbitrary<Outcome> =
          provider.id === "polly" ? sdkOutcome : fetchOutcome;
        const outcomes = fc.oneof(
          { arbitrary: fc.array(adversarialOutcome, { minLength: 1, maxLength: 4 }), weight: 3 },
          { arbitrary: acceptedSequence(provider, operation), weight: 1 },
        );
        await fc.assert(
          fc.asyncProperty(outcomes, fc.boolean(), async (served, long) => {
            const { injected } = serve(provider, served);
            const settled = await settle(run(provider, operation, long));
            if (settled.status === "resolved") {
              checkResolved(operation, settled.value);
              return;
            }
            const kind = rejectionKind(settled.error, injected);
            expect(kind, `rejected with ${String(settled.error)}`).not.toMatch(/^UNEXPECTED/);
          }),
          { numRuns: 120 },
        );
      },
    );

    it.each(OPERATIONS.map((operation) => ({ operation })))(
      "control: $operation resolves on its accepted sequence and rejects on a server error",
      async ({ operation }) => {
        const sequence = accepted(provider, operation);
        const transport = serve(provider, sequence);
        const resolved = await settle(run(provider, operation, false));
        expect(resolved.status).toBe("resolved");
        if (resolved.status === "resolved") {
          checkResolved(operation, resolved.value);
          expectFixtureResult(provider, operation, resolved.value);
        }
        // The declared sequence says whether the operation talks to the
        // service at all: exactly its length in requests, or none.
        expect(transport.requests()).toBe(sequence.length);

        // A static answer (OpenAI's voice list) cannot be made to fail; every
        // operation that made a request must reject a 500.
        if (sequence.length === 0) return;
        serve(provider, [provider.id === "polly" ? SDK_SERVER_ERROR : SERVER_ERROR]);
        const rejected = await settle(run(provider, operation, false));
        expect(rejected.status).toBe("rejected");
        if (rejected.status !== "rejected") return;
        if (provider.id === "polly") {
          // The SDK's own error surfaces verbatim, so its kind is all there is to check.
          expect(rejectionKind(rejected.error, [])).not.toMatch(/^UNEXPECTED/);
          return;
        }
        // A fetch-based provider must raise the typed error with the status
        // on it; a plain `new Error("HTTP 500")` would pass the kind check.
        expect(rejected.error).toBeInstanceOf(ProviderHttpError);
        expect((rejected.error as ProviderHttpError).status).toBe(500);
      },
    );
  },
);

describe("rejectionKind (the oracle) controls", () => {
  it.each([
    ["an uninjected TypeError", new TypeError("fetch failed")],
    ["a RangeError", new RangeError("Invalid array length")],
    ["a string", "boom"],
    ["undefined", undefined],
    ["a plain object", { message: "boom" }],
  ])("classifies %s as UNEXPECTED", (_, error) => {
    expect(rejectionKind(error, [])).toMatch(/^UNEXPECTED/);
  });

  it("classifies the rejections the code raises by kind", () => {
    const injected = networkFailure();
    expect(rejectionKind(injected, [injected])).toBe("network failure, verbatim");
    expect(rejectionKind(new ProviderHttpError("azure", "synthesis", 500), [])).toBe(
      "ProviderHttpError",
    );
    expect(rejectionKind(new Error("HTTP 500"), [])).toBe("Error: HTTP 500");
  });
});
