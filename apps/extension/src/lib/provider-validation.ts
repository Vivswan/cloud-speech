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

type Span = readonly [start: number, end: number];

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s)'"<>]+/gi;

/** The user info of a URL with one of the schemes URL_PATTERN matches: the
 *  authority starts after the scheme's slashes, any number of `/` or `\`,
 *  and runs to the next of those or a `?` or `#`; its last `@` ends the
 *  user info. */
const URL_USER_INFO = /^([a-z]+:[/\\]+)[^/\\?#]*@/i;

/** The parts of every URL in `text` that carry secrets, to drop rather than
 *  mark: the user info before the host and everything from the first `?` or
 *  `#` on. What remains reads as origin and path, as typed. */
function urlSecretSpans(text: string): Span[] {
  return [...text.matchAll(URL_PATTERN)].flatMap((match) => {
    const url = match[0];
    const spans: Span[] = [];
    const userInfo = url.match(URL_USER_INFO);
    if (userInfo) {
      const [withUserInfo, schemePrefix = ""] = userInfo;
      spans.push([match.index + schemePrefix.length, match.index + withUserInfo.length]);
    }
    const cut = url.search(/[?#]/);
    if (cut !== -1) spans.push([match.index + cut, match.index + url.length]);
    return spans;
  });
}

/** Secrets recognized by shape: a bearer token, an AWS key id, the value of
 *  a `key=value` pair, and a long opaque token with no label at all. Where a
 *  label is part of the match it stays in the text: the secret is the
 *  pattern's one capture group, at the end of the match. A label is
 *  `authorization`, `signature`, or a word ending in `token`, `key` or
 *  `secret` with whatever prefix names its kind (access_token, x-api-key,
 *  client_secret); the prefix is bounded so a run of hyphenated words is
 *  not rescanned from every boundary in it. A value ends where a URL does
 *  (URL_PATTERN), so a quoted URL's closing quote stays. Forward matches,
 *  no lookbehind: a variable-length lookbehind rescans the whitespace
 *  before every position, quadratic on a body padded with it. */
const SHAPED_SECRETS = [
  /\bBearer\s+([^\s,;)'"<>]+)/gi,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\b(?:authorization|signature|[A-Za-z0-9_-]{0,32}(?:token|key|secret))\s*[:=]\s*([^\s,;)'"<>]+)/gi,
  /[A-Za-z0-9+/=_-]{40,}/g,
];

function matchSpans(text: string, pattern: RegExp): Span[] {
  return [...text.matchAll(pattern)].map((match) => {
    const end = match.index + match[0].length;
    return [end - (match[1] ?? match[0]).length, end];
  });
}

/** Every place `value` stands in `text`, overlapping ones included. */
function occurrences(text: string, value: string): Span[] {
  const spans: Span[] = [];
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
    spans.push([at, at + value.length]);
  }
  return spans;
}

const WHOLE_TOKEN_BELOW = 4;

/** A character of the kind a key is made of. */
const KEY_CHARACTER = /[A-Za-z0-9_-]/;

/** Whether `text[start, end)` is neither preceded nor followed by a key
 *  character the user will read; one that `blanked` says is going is no
 *  neighbour. */
function standsAlone(
  text: string,
  start: number,
  end: number,
  blanked: (index: number) => boolean,
): boolean {
  const key = (index: number) => KEY_CHARACTER.test(text.charAt(index)) && !blanked(index);
  return !key(start - 1) && !key(end);
}

/** Whether `index` lies in one of `spans`, which are merged: disjoint and
 *  in text order. */
function insideAny(spans: ReadonlyArray<[number, number]>, index: number): boolean {
  let low = 0;
  let high = spans.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const span = spans[mid];
    if (!span) break;
    if (index < span[0]) high = mid - 1;
    else if (index >= span[1]) low = mid + 1;
    else return true;
  }
  return false;
}

function shapedSpans(text: string): Span[] {
  return SHAPED_SECRETS.flatMap((pattern) => matchSpans(text, pattern));
}

/** `text` without `dropped`, as the user will read it, with each position's
 *  origin in `text` (and, one past the end, the text's length). */
function withoutDropped(
  text: string,
  dropped: ReadonlyArray<[number, number]>,
): { view: string; origin: number[] } {
  const parts: string[] = [];
  const origin: number[] = [];
  let cursor = 0;
  for (const [start, end] of [...dropped, [text.length, text.length] as const]) {
    parts.push(text.slice(cursor, start));
    for (let index = cursor; index < start; index++) origin.push(index);
    cursor = end;
  }
  origin.push(text.length);
  return { view: parts.join(""), origin };
}

/** Every place a configured value stands: in the intact `text`, and in the
 *  text as the user will read it once `dropped` is gone, where a value the
 *  drops joined (a base URL around the user info a proxy added) is
 *  contiguous for the first time; both as spans of `text`, so everything is
 *  rendered once and no rule ever reads a "[redacted]" mark. A value under
 *  four characters counts only as a whole token ("abc" in "Rejected
 *  credential abc", not inside "abcdef"): blanking every occurrence of a
 *  string that short would damage ordinary words in the diagnostic. Its
 *  neighbours are the characters the user will read: one inside a dropped
 *  span, a `shaped` secret, or a longer configured value is no neighbour. */
function configuredSpans(
  text: string,
  values: readonly string[],
  dropped: ReadonlyArray<[number, number]> = [],
  shaped: readonly Span[] = [],
): Span[] {
  const { view, origin } = withoutDropped(text, dropped);
  const inText = ([start, end]: Span): Span => [origin[start] ?? 0, (origin[end - 1] ?? -1) + 1];
  const everywhere = (value: string): Span[] => [
    ...occurrences(text, value),
    ...occurrences(view, value).map(inText),
  ];
  const long = values.filter((value) => value.length >= WHOLE_TOKEN_BELOW).flatMap(everywhere);
  const going = mergeSpans([...shaped, ...dropped, ...long]);
  const blankedInText = (index: number) => insideAny(going, index);
  const blankedInView = (index: number) => insideAny(going, origin[index] ?? -1);
  const short = values
    .filter((value) => value.length < WHOLE_TOKEN_BELOW)
    .flatMap((value) => [
      ...occurrences(text, value).filter(([start, end]) =>
        standsAlone(text, start, end, blankedInText),
      ),
      ...occurrences(view, value)
        .filter(([start, end]) => standsAlone(view, start, end, blankedInView))
        .map(inText),
    ]);
  return [...long, ...short];
}

interface Replacement {
  start: number;
  end: number;
  /** Marked "[redacted]" (a secret) or dropped without a trace (a URL's
   *  query). */
  marked: boolean;
}

/** `spans` with overlapping and touching ones merged, in text order. */
function mergeSpans(spans: readonly Span[]): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** The `marks` not wholly inside a drop. Both lists are merged, so disjoint
 *  and in text order: the one drop that can hold a mark is the first one
 *  ending at or after it, and one walk over both lists finds it. */
function outsideDrops(
  marks: ReadonlyArray<[number, number]>,
  drops: ReadonlyArray<[number, number]>,
): Array<[number, number]> {
  const kept: Array<[number, number]> = [];
  let next = 0;
  for (const mark of marks) {
    while (next < drops.length && (drops[next]?.[1] ?? 0) < mark[1]) next++;
    const drop = drops[next];
    if (drop && drop[0] <= mark[0] && mark[1] <= drop[1]) continue;
    kept.push(mark);
  }
  return kept;
}

/** `text` with every `blanked` span marked "[redacted]" and every `dropped`
 *  span removed. All spans were found on the intact text and overlapping
 *  ones merge before anything is replaced, so no rule can cut another's
 *  match in two and leave a fragment behind. A secret wholly inside a
 *  dropped range goes with it; one reaching past it marks the merged range.
 *  The text is NEVER truncated: the user must always be able to read the
 *  provider's full error. */
function redactSpans(
  text: string,
  blanked: readonly Span[],
  dropped: readonly Span[] = [],
): string {
  const drops = mergeSpans(dropped);
  const marks = outsideDrops(mergeSpans(blanked), drops);
  const merged: Replacement[] = [];
  for (const { start, end, marked } of [
    ...marks.map(([start, end]) => ({ start, end, marked: true })),
    ...drops.map(([start, end]) => ({ start, end, marked: false })),
  ].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1];
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end);
      last.marked ||= marked;
    } else {
      merged.push({ start, end, marked });
    }
  }
  let redacted = "";
  let cursor = 0;
  for (const { start, end, marked } of merged) {
    redacted += text.slice(cursor, start) + (marked ? "[redacted]" : "");
    cursor = end;
  }
  return redacted + text.slice(cursor);
}

/** A diagnostic made safe by shape alone, for a detail whose configured
 *  credential values are not at hand. */
export function redactSecrets(text: string): string {
  return redactSpans(text, shapedSpans(text), urlSecretSpans(text));
}

type Configured = Iterable<readonly [TtsProvider, Record<string, string>]>;

function configuredValues(credentials: Configured): string[] {
  return [...credentials].flatMap(([provider, typed]) => credentialValues(provider, typed));
}

/** `text` with the configured credential values of every provider blanked
 *  and nothing else: for a field that is not a diagnostic (a sentence, a
 *  link) and must keep its shape, query and all. */
export function redactCredentials(text: string, credentials: Configured): string {
  return redactSpans(text, configuredSpans(text, configuredValues(credentials)));
}

/** The credential values the user typed for `provider`, the ones its schema
 *  names, blank ones left out. */
function credentialValues(provider: TtsProvider, credentials: Record<string, string>): string[] {
  const credentialKeys = new Set(provider.credentialSchema.map((field) => field.key));
  return Object.entries(credentials)
    .filter(([key, value]) => credentialKeys.has(key) && value.trim().length > 0)
    .map(([, value]) => value);
}

/** `text` made safe to show in the popup or write to logs: every secret
 *  known by shape, the configured values of every provider (in the intact
 *  text and in what remains once the URL parts are dropped), and the secret
 *  parts of its URLs, all as spans of the same intact text. */
export function sanitizeDetail(text: string, credentials: Configured): string {
  const dropped = mergeSpans(urlSecretSpans(text));
  const shaped = shapedSpans(text);
  return redactSpans(
    text,
    [...shaped, ...configuredSpans(text, configuredValues(credentials), dropped, shaped)],
    dropped,
  );
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
