import fc from "fast-check";

// Arbitrary HTTP responses for the provider parsing properties: any status,
// and bodies from the shapes a provider can meet (bytes, JSON of every type,
// error envelopes with the message in the wrong type, JSON cut short, nothing
// at all, an HTML page behind a 2xx). Served through the plain object the
// providers read (`ok`, `status`, `headers`, `text`, `json`, `arrayBuffer`)
// rather than a real Response: the Response constructor refuses 1xx statuses
// and bodies on 204/304, exactly the corners worth fuzzing.

export interface ResponseSpec {
  status: number;
  contentType: string | null;
  body: Uint8Array;
  /** Reading the body fails the way a connection cut mid-transfer does. */
  bodyReadFails: boolean;
}

export type FetchOutcome = { kind: "response"; spec: ResponseSpec } | { kind: "networkFailure" };

const utf8 = new TextEncoder();

const status = fc.oneof(
  { arbitrary: fc.integer({ min: 100, max: 599 }), weight: 2 },
  {
    arbitrary: fc.constantFrom(200, 200, 200, 204, 400, 401, 403, 404, 429, 500, 502, 503),
    weight: 3,
  },
);

const contentType = fc.constantFrom(
  null,
  "audio/mpeg",
  "audio/ogg",
  "application/json",
  "application/json; charset=utf-8",
  "text/html; charset=utf-8",
  "text/plain",
);

const jsonText = fc.jsonValue().map((value) => JSON.stringify(value));

/** `{ error: { message } }` envelopes where the message is anything at all,
 *  plus envelopes with the wrong nesting. */
const errorEnvelope = fc.oneof(
  fc.jsonValue().map((message) => JSON.stringify({ error: { message } })),
  fc.jsonValue().map((error) => JSON.stringify({ error })),
  fc.string().map((message) => JSON.stringify({ error: { code: 400, message, status: "X" } })),
);

const truncatedJson = fc
  .tuple(fc.oneof(jsonText, errorEnvelope), fc.double({ min: 0, max: 1, noNaN: true }))
  .map(([text, fraction]) => text.slice(0, Math.floor(text.length * fraction)));

const html = fc
  .string({ maxLength: 40 })
  .map((title) => `<!doctype html><html><head><title>${title}</title></head><body></body></html>`);

/** Bodies shaped like a provider's own success payload but with every field
 *  free to hold the wrong type, so the schema boundary is exercised. */
const loose = fc.oneof(fc.string({ maxLength: 12 }), fc.jsonValue());
const providerShaped = fc.oneof(
  // Google voices
  fc
    .array(
      fc.record(
        {
          name: loose,
          languageCodes: fc.oneof(fc.array(fc.string({ maxLength: 6 })), loose),
          ssmlGender: loose,
          naturalSampleRateHertz: loose,
        },
        { requiredKeys: [] },
      ),
      { maxLength: 3 },
    )
    .map((voices) => JSON.stringify({ voices })),
  // Google synthesis
  fc
    .oneof(
      fc.uint8Array({ maxLength: 24 }).map((bytes) => btoa(String.fromCharCode(...bytes))),
      loose,
    )
    .map((audioContent) => JSON.stringify({ audioContent })),
  // Azure voices
  fc
    .array(
      fc.record(
        {
          ShortName: loose,
          LocalName: loose,
          Locale: loose,
          Gender: loose,
          VoiceType: loose,
          StyleList: fc.oneof(fc.array(fc.string({ maxLength: 8 })), loose),
        },
        { requiredKeys: [] },
      ),
      { maxLength: 3 },
    )
    .map((voices) => JSON.stringify(voices)),
  // OpenAI-compatible voice discovery
  fc.oneof(fc.array(loose, { maxLength: 4 }), loose).map((voices) => JSON.stringify({ voices })),
);

const body: fc.Arbitrary<Uint8Array> = fc.oneof(
  fc.constant(new Uint8Array(0)),
  fc.uint8Array({ maxLength: 64 }),
  jsonText.map((text) => utf8.encode(text)),
  errorEnvelope.map((text) => utf8.encode(text)),
  truncatedJson.map((text) => utf8.encode(text)),
  html.map((text) => utf8.encode(text)),
  { arbitrary: providerShaped.map((text) => utf8.encode(text)), weight: 3 },
);

export const responseSpec: fc.Arbitrary<ResponseSpec> = fc.record({
  status,
  contentType,
  body,
  bodyReadFails: fc.oneof(
    { arbitrary: fc.constant(false), weight: 5 },
    { arbitrary: fc.constant(true), weight: 1 },
  ),
});

export const fetchOutcome: fc.Arbitrary<FetchOutcome> = fc.oneof(
  { arbitrary: responseSpec.map((spec) => ({ kind: "response", spec }) as const), weight: 9 },
  { arbitrary: fc.constant({ kind: "networkFailure" } as const), weight: 1 },
);

/** The failure a body read raises when the connection drops mid-transfer. */
export function bodyReadFailure(): Error {
  return new TypeError("terminated");
}

/** The failure `fetch` itself raises when the request never got a response. */
export function networkFailure(): Error {
  return new TypeError("fetch failed");
}

/** Build the response object a provider reads, behaving consistently with
 *  its spec: `text` decodes the body, `json` parses that text (and throws the
 *  SyntaxError a real Response would), `arrayBuffer` hands the bytes back. */
export function fakeResponse(spec: ResponseSpec, readFailure: Error): Response {
  const text = new TextDecoder().decode(spec.body);
  const read = <T>(value: () => T): Promise<T> =>
    spec.bodyReadFails
      ? Promise.reject(readFailure)
      : new Promise((resolve, reject) => {
          try {
            resolve(value());
          } catch (error) {
            reject(error);
          }
        });
  const headers = new Headers();
  if (spec.contentType !== null) headers.set("content-type", spec.contentType);
  const response = {
    ok: spec.status >= 200 && spec.status < 300,
    status: spec.status,
    headers,
    text: () => read(() => text),
    json: () => read(() => JSON.parse(text) as unknown),
    arrayBuffer: () =>
      read(() =>
        spec.body.buffer.slice(spec.body.byteOffset, spec.body.byteOffset + spec.body.byteLength),
      ),
  };
  return response as unknown as Response;
}
