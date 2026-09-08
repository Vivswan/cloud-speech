import { z } from "zod";
import type { NormalizedVoice, TtsProvider } from "@/providers/types";
import { ProviderHttpError } from "./provider-http";
import { retryTransient } from "./retry";
import { isAbortError } from "./slot";

export const VALIDATION_FAILURE_CODES = [
  "authentication",
  "permission",
  "region",
  "quota",
  "network",
  "storage",
  "unknown",
  /** Overtaken by a newer Save & test for the same provider: nothing was
   *  stored, and the newer one reports for both. Not a failure to show. */
  "superseded",
] as const;

export type ValidationFailureCode = (typeof VALIDATION_FAILURE_CODES)[number];

export const ProviderValidationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(VALIDATION_FAILURE_CODES),
    detail: z.string().optional(),
  }),
]);

export type ProviderValidationResult = z.infer<typeof ProviderValidationResultSchema>;

type ValidationPhase = "provider" | "storage";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusFromError(error: unknown): number | undefined {
  if (error instanceof ProviderHttpError) return error.status;
  const record = asRecord(error);
  if (!record) return undefined;

  for (const value of [record.status, record.statusCode]) {
    if (typeof value === "number") return value;
  }

  const metadata = asRecord(record.$metadata);
  if (typeof metadata?.httpStatusCode === "number") return metadata.httpStatusCode;

  const message = stringValue(record.message);
  const statusMatch = message?.match(/\b([45]\d\d)\b/);
  return statusMatch?.[1] ? Number(statusMatch[1]) : undefined;
}

function rawErrorText(error: unknown): string {
  // Self-describing: its message already names the provider, operation, and
  // status, so the SDK-error reconstruction below would only repeat them.
  if (error instanceof ProviderHttpError) return error.message;
  const record = asRecord(error);
  const name = stringValue(record?.name);
  const code = stringValue(record?.code);
  const message = stringValue(record?.message) ?? (typeof error === "string" ? error : undefined);
  const status = statusFromError(error);
  return [
    code ?? (name === "Error" ? undefined : name),
    status ? `HTTP ${status}` : undefined,
    message,
  ]
    .filter(Boolean)
    .join(": ");
}

function stripUrlSecrets(value: string): string {
  return value.replace(/\b(?:https?|wss?):\/\/[^\s)'"<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}`;
    } catch {
      return candidate.replace(/[?#].*$/, "");
    }
  });
}

/** Secrets recognized by shape: a bearer token, an AWS key id, the value of
 *  a `key=value` pair, and a long opaque token with no label at all. Where a
 *  label is part of the match it stays in the text: the secret is the
 *  pattern's one capture group, at the end of the match. Forward matches, no
 *  lookbehind: a variable-length lookbehind rescans the whitespace before
 *  every position, quadratic on a body padded with it. */
const SHAPED_SECRETS = [
  /\bBearer\s+([^\s,;)]+)/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:authorization|api[-_ ]?key|token|signature|secret)\s*[:=]\s*([^\s,;)]+)/gi,
  /[A-Za-z0-9+/=_-]{40,}/g,
];

type Span = readonly [start: number, end: number];

function matchSpans(text: string, pattern: RegExp): Span[] {
  return [...text.matchAll(pattern)].map((match) => {
    const end = match.index + match[0].length;
    return [end - (match[1] ?? match[0]).length, end];
  });
}

/** Every place `value` stands in `text`. A value under four characters
 *  counts only as a whole token ("abc" in "Rejected credential abc", not
 *  inside "abcdef"): blanking every occurrence of a string that short would
 *  damage ordinary words in the diagnostic. */
function valueSpans(text: string, value: string): Span[] {
  if (value.length < WHOLE_TOKEN_BELOW) return matchSpans(text, wholeToken(value));
  const spans: Span[] = [];
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + value.length)) {
    spans.push([at, at + value.length]);
  }
  return spans;
}

const WHOLE_TOKEN_BELOW = 4;

/** `value` where it stands alone: not preceded or followed by another
 *  character of the kind a key is made of. */
function wholeToken(value: string): RegExp {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, "g");
}

function shapedSpans(text: string): Span[] {
  return SHAPED_SECRETS.flatMap((pattern) => matchSpans(text, pattern));
}

function configuredSpans(text: string, values: readonly string[]): Span[] {
  return values.flatMap((value) => valueSpans(text, value));
}

/** `text` with every span blanked. The spans were all found on the intact
 *  text, and overlapping ones merge before anything is replaced, so no rule
 *  can cut another's match in two and leave a fragment behind (a configured
 *  value inside a long opaque token, a `key=value` label inside a configured
 *  value, a JWT's long segments). The text is NEVER truncated: the user must
 *  always be able to read the provider's full error. */
function blankSpans(text: string, spans: readonly Span[]): string {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  let redacted = "";
  let cursor = 0;
  for (const [start, end] of merged) {
    redacted += `${text.slice(cursor, start)}[redacted]`;
    cursor = end;
  }
  return redacted + text.slice(cursor);
}

/** A diagnostic made safe by shape alone, for a detail whose configured
 *  credential values are not at hand. */
export function redactSecrets(text: string): string {
  const stripped = stripUrlSecrets(text);
  return blankSpans(stripped, shapedSpans(stripped));
}

type Configured = Iterable<readonly [TtsProvider, Record<string, string>]>;

function configuredValues(credentials: Configured): string[] {
  return [...credentials].flatMap(([provider, typed]) => credentialValues(provider, typed));
}

/** `text` with the configured credential values of every provider blanked
 *  and nothing else: for a field that is not a diagnostic (a sentence, a
 *  link) and must keep its shape, query and all. */
export function redactCredentials(text: string, credentials: Configured): string {
  return blankSpans(text, configuredSpans(text, configuredValues(credentials)));
}

/** The credential values the user typed for `provider`, the ones its schema
 *  names, blank ones left out. */
function credentialValues(provider: TtsProvider, credentials: Record<string, string>): string[] {
  const credentialKeys = new Set(provider.credentialSchema.map((field) => field.key));
  return Object.entries(credentials)
    .filter(([key, value]) => credentialKeys.has(key) && value.trim().length > 0)
    .map(([, value]) => value);
}

/** `text` made safe to show in the popup or write to logs: URL queries and
 *  fragments go (a credential that is itself a URL prefix, the custom
 *  server's base URL, would otherwise leave the query unrecognizable), then
 *  every secret redactSpans knows, with the configured values of every
 *  provider among them. */
export function sanitizeDetail(text: string, credentials: Configured): string {
  const stripped = stripUrlSecrets(text);
  return blankSpans(stripped, [
    ...shapedSpans(stripped),
    ...configuredSpans(stripped, configuredValues(credentials)),
  ]);
}

/** The diagnostic of a failed Save & test, in one line. */
export function sanitizeValidationDetail(
  error: unknown,
  provider: TtsProvider,
  credentials: Record<string, string>,
): string | undefined {
  const detail = rawErrorText(error).replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  return sanitizeDetail(detail, [[provider, credentials]]);
}

export function classifyValidationError(
  error: unknown,
  provider: TtsProvider,
  credentials: Record<string, string>,
  phase: ValidationPhase = "provider",
): Exclude<ProviderValidationResult, { ok: true }> {
  const detail = sanitizeValidationDetail(error, provider, credentials);
  if (phase === "storage") return { ok: false, code: "storage", detail };

  const raw = rawErrorText(error).toLowerCase();
  const status = statusFromError(error);
  let code: ValidationFailureCode = "unknown";

  if (/quota|throttl|rate.?limit|too many requests/.test(raw) || status === 429) {
    code = "quota";
  } else if (
    /invalidclienttokenid|signaturedoesnotmatch|unrecognizedclient|invalid.*(?:key|token|credential)|authentication/.test(
      raw,
    ) ||
    status === 401
  ) {
    code = "authentication";
  } else if (/accessdenied|forbidden|not authorized|permission/.test(raw) || status === 403) {
    code = "permission";
  } else if (
    /invalid region|unknown region|region.*(?:missing|mismatch|required|invalid)|invalid endpoint/.test(
      raw,
    )
  ) {
    code = "region";
  } else if (
    /failed to fetch|network|websocket|timed? ?out|timeout|aborterror|enotfound|econn|connection/.test(
      raw,
    )
  ) {
    code = "network";
  }

  return { ok: false, code, detail };
}

/** A validation overtaken by a newer Save & test for the same provider: its
 *  request was cancelled (or its commit refused), and nothing was stored. */
const SUPERSEDED: ProviderValidationResult = { ok: false, code: "superseded" };

/** Validate the candidate (a throttled or failing provider is retried, a
 *  rejected key is not), then commit only the proven credentials and voices.
 *  `commit` decides, under its own write lock, whether this candidate is
 *  still the newest one; only "persisted" counts as success. */
export async function validateProviderCandidate(
  provider: TtsProvider,
  credentials: Record<string, string>,
  commit: (voices: NormalizedVoice[]) => Promise<"persisted" | "superseded">,
  signal?: AbortSignal,
): Promise<ProviderValidationResult> {
  // Superseded while the caller was still loading settings: every exit from
  // here on says so, instead of reporting the stale draft's missing fields.
  if (signal?.aborted) return SUPERSEDED;

  const missingFields = provider.credentialSchema
    .filter((field) => !field.optional && !credentials[field.key]?.trim())
    .map((field) => field.key);
  if (missingFields.length > 0) {
    return {
      ok: false,
      code: missingFields.includes("region") ? "region" : "authentication",
      detail: `Missing required field${missingFields.length === 1 ? "" : "s"}: ${missingFields.join(", ")}`,
    };
  }

  let voices: NormalizedVoice[];
  try {
    voices = await retryTransient(
      () => provider.validateAndFetchVoices(credentials, signal),
      signal,
      provider,
    );
    if (voices.length === 0) throw new Error("Provider returned no voices");
  } catch (error) {
    if (isAbortError(error)) return SUPERSEDED;
    return classifyValidationError(error, provider, credentials);
  }

  let outcome: "persisted" | "superseded";
  try {
    outcome = await commit(voices);
  } catch (error) {
    return classifyValidationError(error, provider, credentials, "storage");
  }
  return outcome === "persisted" ? { ok: true } : SUPERSEDED;
}
