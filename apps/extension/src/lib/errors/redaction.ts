import type { TtsProvider } from "@/providers/types";

// Pure text redaction, imported by the page-injected content script through
// lib/errors/log.ts: nothing here may pull a provider, a schema, or the registry.

type Span = readonly [start: number, end: number];

const URL_PATTERN = /\b(?:https?|wss?):\/\/[^\s)'"<>]+/gi;

/** Backslashes count as slashes, as browsers parse them; the last `@` before
 *  the path ends the user info. */
const URL_USER_INFO = /^([a-z]+:[/\\]+)[^/\\?#]*@/i;

/** Dropped rather than marked: the user info and everything from the first
 *  `?` or `#` on, so what remains reads as origin and path. */
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

/** The value after a label or `Bearer`, blanked whole. A quoted run admits no
 *  whitespace and none of its own opener, so a quote that never closes opens
 *  no value and the scan never rescans the rest of the text from every one.
 *
 *  "..." '...' <...>          -> quotes included; a backslash escapes the next character
 *  unquoted, then "x...       -> a quote directly followed by key material is part of the value
 *  unquoted, then ") or "<sp> -> the quote ends the run and stays in the text
 */
const LABELLED_VALUE = [
  String.raw`"(?:[^"\\\s]|\\\S)+"`,
  String.raw`'(?:[^'\\\s]|\\\S)+'`,
  String.raw`<(?:[^<>\\\s]|\\\S)+>`,
  String.raw`[^\s,;)'"<>]+(?:["'][A-Za-z0-9][^\s,;)'"<>]*)*`,
].join("|");

/** Forward matches with a bounded label prefix: a variable-length lookbehind
 *  or an unbounded prefix rescans from every position, quadratic on a body
 *  padded with whitespace or hyphenated words. A label stays in the text; the
 *  secret is the pattern's one capture group, at the end of the match.
 *
 *  Bearer <value>               -> the value
 *  AKIA/ASIA + 16 chars         -> the whole key id
 *  <label>[:=] <value>          -> the value; a label is authorization, signature, or a word ending in token/key/secret
 *  40+ opaque chars, no label   -> the whole token
 */
const SHAPED_SECRETS = [
  new RegExp(String.raw`\bBearer\s+(${LABELLED_VALUE})`, "gi"),
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  new RegExp(
    String.raw`\b(?:authorization|signature|[A-Za-z0-9_-]{0,32}(?:token|key|secret))\s*[:=]\s*(${LABELLED_VALUE})`,
    "gi",
  ),
  /[A-Za-z0-9+/=_-]{40,}/g,
];

function matchSpans(text: string, pattern: RegExp): Span[] {
  return [...text.matchAll(pattern)].map((match) => {
    const end = match.index + match[0].length;
    return [end - (match[1] ?? match[0]).length, end];
  });
}

/** The KMP failure table: for each prefix of `value`, the length of its
 *  longest proper border (a prefix that is also a suffix). */
function borders(value: string): number[] {
  const table = [0];
  let border = 0;
  for (let index = 1; index < value.length; index++) {
    while (border > 0 && value.charCodeAt(index) !== value.charCodeAt(border)) {
      border = table[border - 1] ?? 0;
    }
    if (value.charCodeAt(index) === value.charCodeAt(border)) border++;
    table.push(border);
  }
  return table;
}

/** Overlapping occurrences included, in text order. One KMP pass: a value
 *  echoed at every position of a run costs the run's length, not its own
 *  length per hit. */
export function occurrences(text: string, value: string): Span[] {
  const spans: Span[] = [];
  if (value.length === 0 || value.length > text.length) return spans;
  const table = borders(value);
  let matched = 0;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    while (matched > 0 && code !== value.charCodeAt(matched)) matched = table[matched - 1] ?? 0;
    if (code === value.charCodeAt(matched)) matched++;
    if (matched === value.length) {
      spans.push([index + 1 - value.length, index + 1]);
      matched = table[matched - 1] ?? 0;
    }
  }
  return spans;
}

const WHOLE_TOKEN_BELOW = 4;

const KEY_CHARACTER = /[A-Za-z0-9_-]/;

/** A neighbour that `blanked` says is going does not count: the user will
 *  not read it. */
function standsAlone(
  text: string,
  start: number,
  end: number,
  blanked: (index: number) => boolean,
): boolean {
  const key = (index: number) => KEY_CHARACTER.test(text.charAt(index)) && !blanked(index);
  return !key(start - 1) && !key(end);
}

/** `spans` must be merged (disjoint, in text order) for the binary search. */
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

/** `origin` maps each position of `view` back to `text`, with one extra entry
 *  (the text's length) for the position one past the end. */
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

/** Both the intact text and the view with `dropped` gone are scanned: a value
 *  the drops joined (a base URL around the user info a proxy added) is
 *  contiguous only in the view. Results are spans of `text`, so everything is
 *  rendered once and no rule ever reads a "[redacted]" mark.
 *
 *  Under WHOLE_TOKEN_BELOW characters, only a whole token counts, or ordinary words would be damaged:
 *    "abc" in "Rejected credential abc"  -> blanked
 *    "abc" inside "abcdef"               -> kept
 */
function configuredSpans(
  text: string,
  values: readonly string[],
  dropped: ReadonlyArray<[number, number]> = [],
  shaped: readonly Span[] = [],
): Span[] {
  // With nothing dropped the view would only repeat the text's hits.
  const { view, origin } =
    dropped.length === 0 ? { view: "", origin: [] as number[] } : withoutDropped(text, dropped);
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

function mergeSpans(spans: readonly Span[]): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [start, end] of [...spans].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

/** Both lists must be merged: the one drop that can hold a mark is then the
 *  first one ending at or after it, and one walk over both finds it. */
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

/** Overlapping spans merge before anything is replaced, so no rule can cut
 *  another's match in two and leave a fragment behind. The text is never
 *  truncated: the user must be able to read the provider's full error. */
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

/** Only the configured values, nothing by shape: for a field that is not a
 *  diagnostic (a sentence, a link) and must keep its shape, query and all. */
export function redactCredentials(text: string, credentials: Configured): string {
  return redactSpans(text, configuredSpans(text, configuredValues(credentials)));
}

function credentialValues(provider: TtsProvider, credentials: Record<string, string>): string[] {
  const credentialKeys = new Set(provider.credentialSchema.map((field) => field.key));
  return Object.entries(credentials)
    .filter(([key, value]) => credentialKeys.has(key) && value.trim().length > 0)
    .map(([, value]) => value);
}

/** Safe to show in the popup or write to logs. Shaped secrets and URL parts
 *  are found on the intact text; configured values also on the text with
 *  those URL parts dropped, where a value the user info split (a proxy's base
 *  URL) is contiguous. */
export function sanitizeDetail(text: string, credentials: Configured): string {
  const dropped = mergeSpans(urlSecretSpans(text));
  const shaped = shapedSpans(text);
  return redactSpans(
    text,
    [...shaped, ...configuredSpans(text, configuredValues(credentials), dropped, shaped)],
    dropped,
  );
}
