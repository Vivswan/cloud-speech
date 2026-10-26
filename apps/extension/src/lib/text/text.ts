import he from "he";
import { Tokenizer, type TokenizerCallbacks } from "htmlparser2";
import sanitizeHtml from "sanitize-html";
import model from "wink-eng-lite-web-model";
import winkNLP from "wink-nlp";

const nlp = winkNLP(model);

const SPEAK_START = "<speak>";
const SPEAK_END = "</speak>";

export function isSSML(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<speak") && trimmed.endsWith(SPEAK_END);
}

/** Only for text a provider wraps in SSML tags; plain-text API paths (Polly
 *  TEXT type, Google text input, OpenAI) must NOT escape. */
export function escapeXml(text: string): string {
  return he.escape(text);
}

/** In Polly's and Azure's prosody dialects an unsigned "5%" is a different value from "+5%", so a
 *  non-negative figure carries its plus sign. */
function signed(value: number): string {
  return value >= 0 ? `+${value}` : `${value}`;
}

export function signedPercent(value: number): string {
  return `${signed(value)}%`;
}

export function signedDecibels(value: number): string {
  return `${signed(value)}dB`;
}

/** The content of a complete SSML document without its root element, for a provider that supplies
 *  its own <speak> envelope. */
export function unwrapSpeak(ssml: string): string {
  return ssml.trim().replace(/<speak[^>]*>(.*)<\/speak>/s, "$1");
}

/** Repeated to a fixpoint, as CodeQL's incomplete-sanitization check requires
 *  of tag stripping; terminates because every pass strictly shrinks the
 *  string. */
function stripTagsCompletely(text: string, replacement = ""): string {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(/<[^>]*>/g, replacement);
  } while (current !== previous);
  return current;
}

export function stripSsmlTags(text: string): string {
  return he.decode(stripTagsCompletely(text, " ").replace(/\s+/g, " ").trim());
}

export type SizeOf = (text: string) => number;

export const charSize: SizeOf = (text) => text.length;

const utf8Encoder = new TextEncoder();

export const utf8ByteLength: SizeOf = (text) => utf8Encoder.encode(text).length;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** The longest prefix within `limit` by `sizeOf`, in UTF-16 units; it may end
 *  inside a surrogate pair. */
function largestFittingPrefix(text: string, limit: number, sizeOf: SizeOf): number {
  if (sizeOf === charSize) return Math.min(limit, text.length);

  // sizeOf over prefixes is monotonic: binary search the largest fit.
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = low + Math.ceil((high - low) / 2);
    if (sizeOf(text.slice(0, mid)) <= limit) low = mid;
    else high = mid - 1;
  }
  return low;
}

function splitsSurrogatePair(text: string, index: number): boolean {
  return (
    index > 0 &&
    index < text.length &&
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  );
}

/** 2 for a surrogate pair at the front, else 1; `charCodeAt` past the end is
 *  NaN, which is no surrogate. */
function firstCodePointLength(text: string): number {
  const pair = isHighSurrogate(text.charCodeAt(0)) && isLowSurrogate(text.charCodeAt(1));
  return pair ? 2 : 1;
}

/** Never splits a surrogate pair. With `forceProgress` it always advances by
 *  at least one code point, overshooting a pathological limit; without, it
 *  returns 0 when nothing fits so the caller can free budget instead. */
function fittingPrefixLength(
  text: string,
  limit: number,
  sizeOf: SizeOf,
  forceProgress = true,
): number {
  let index = largestFittingPrefix(text, limit, sizeOf);
  if (splitsSurrogatePair(text, index)) index--;

  if (index > 0) return index;
  if (!forceProgress) return 0;
  return firstCodePointLength(text);
}

const PARAGRAPH_BREAK = /\n\s*\n/;

/** Each sentence with the whitespace before it, so a chunk packed from
 *  consecutive sentences is a verbatim slice of `text`. A blank line is split
 *  here because the splitter takes "A\n\nB" apart but reads "A\n\n\n\nB" as
 *  one sentence. */
function* sentencesWithGaps(text: string): Generator<{ gap: string; sentence: string }> {
  let cursor = 0;
  for (const paragraph of text.split(PARAGRAPH_BREAK)) {
    const sentences: string[] = nlp.readDoc(paragraph).sentences().out();
    for (const sentence of sentences) {
      if (!sentence.trim()) continue;
      const start = text.indexOf(sentence, cursor);
      // The splitter drops whitespace such as a form feed, which only
      // sanitizeTextForSSML keeps away from it; a gap guessed here would be
      // spoken twice.
      if (start < 0) throw new Error(`Sentence splitter altered the text at ${cursor}`);
      yield { gap: text.slice(cursor, start), sentence };
      cursor = start + sentence.length;
    }
  }
}

export function chunkText(text: string, maxChunkSize = 5000, sizeOf: SizeOf = charSize): string[] {
  if (isSSML(text)) return chunkSSML(text, maxChunkSize, sizeOf);

  const chunks: string[] = [];
  let current = "";
  const flush = () => {
    if (current.trim()) chunks.push(current);
    current = "";
  };
  for (const { gap, sentence } of sentencesWithGaps(text)) {
    if (sizeOf(sentence) <= maxChunkSize) {
      const packed = current === "" ? sentence : current + gap + sentence;
      if (sizeOf(packed) <= maxChunkSize) {
        current = packed;
        continue;
      }
      flush();
      current = sentence;
      continue;
    }
    flush();
    let remaining = sentence;
    while (sizeOf(remaining) > maxChunkSize) {
      const hard = fittingPrefixLength(remaining, maxChunkSize, sizeOf);
      let cut = remaining.lastIndexOf(" ", hard);
      if (cut <= 0) cut = hard;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    current = remaining;
  }
  flush();
  return chunks;
}

interface OpenTag {
  name: string;
  raw: string;
  closer: string;
}

const CDATA_START = "<![CDATA[";
const CDATA_END = "]]>";

/** `[start, end)` in the source document. */
interface Span {
  start: number;
  end: number;
}

/** Character data a cut may fall inside. `references` are the spans a cut
 *  must never land in; CDATA content is re-delimited in every chunk it is
 *  cut across. */
interface TextToken extends Span {
  kind: "text" | "cdata";
  references: Span[];
}

/** Markup, kept verbatim and never cut. `void` is anything that neither opens
 *  nor closes an element: self-closing tags, comments, processing
 *  instructions. */
interface MarkupToken extends Span {
  kind: "open" | "close" | "void";
  name: string;
}

type Token = TextToken | MarkupToken;

/** The chunk being packed, and what the next one must reopen. */
interface SsmlChunking {
  /** The trimmed document every token indexes into. */
  readonly source: string;

  /** The provider's measure of a chunk. */
  readonly sizeOf: SizeOf;

  /** maxChunkSize less the `<speak>` envelope every chunk gets, at least 1. */
  readonly budget: number;

  /** Finished chunks, each a `<speak>` document. */
  readonly chunks: string[];

  /** Elements open in `current`, outermost first. */
  readonly stack: OpenTag[];

  /** Openers the nesting bailout dropped; their closers are swallowed, or a chunk would carry them unmatched. */
  orphanedOpeners: number;

  /** The chunk being packed, without its envelope. */
  current: string;

  /** Whether `current` holds text worth a request: tags alone are not. */
  speakable: boolean;
}

/** htmlparser2's tokenizer reports positions instead of building a tree, so
 *  text and markup are copied as source bytes, never re-serialized. It is
 *  lenient: a bare `&` or `<` stays character data instead of raising. */
function tokenizeSsml(source: string): Token[] {
  const tokens: Token[] = [];
  let cursor = 0;
  let openName = "";

  // Text and the references inside it arrive as separate callbacks; they
  // form one text token so a cut can be placed anywhere along the run.
  const textToken = (): TextToken => {
    const last = tokens[tokens.length - 1];
    if (last?.kind === "text") return last;
    const token: TextToken = { kind: "text", start: cursor, end: cursor, references: [] };
    tokens.push(token);
    return token;
  };
  // Trailing markup left open at the end of the input reports one past it.
  const markup = (kind: MarkupToken["kind"], name: string, end: number) => {
    const clamped = Math.min(end, source.length);
    tokens.push({ kind, name, start: cursor, end: clamped });
    cursor = clamped;
  };
  const ignore = () => {};

  const callbacks: TokenizerCallbacks = {
    ontext(_start, end) {
      textToken().end = end;
      cursor = end;
    },
    ontextentity(_codePoint, end) {
      const token = textToken();
      token.references.push({ start: cursor, end });
      token.end = end;
      cursor = end;
    },
    onopentagname(start, end) {
      openName = source.slice(start, end);
    },
    // `end` is the index of the tag's `>`.
    onopentagend(end) {
      markup("open", openName, end + 1);
    },
    onselfclosingtag(end) {
      markup("void", openName, end + 1);
    },
    // The name ends at `end`; the tokenizer then skips to the next `>`.
    onclosetag(start, end) {
      const close = source.indexOf(">", end);
      markup("close", source.slice(start, end), close < 0 ? source.length : close + 1);
    },
    oncomment(_start, end) {
      markup("void", "", end + 1);
    },
    // The content ends `offset` before the `>`; the delimiters are not part of
    // the token because every chunk adds its own. An empty section, or one
    // left open at the end of the input, stays raw bytes: nothing to cut, and
    // nothing to close for the author.
    oncdata(start, end, offset) {
      const contentEnd = end - offset;
      if (end >= source.length || contentEnd === start) {
        markup("void", "", end + 1);
        return;
      }
      tokens.push({ kind: "cdata", start, end: contentEnd, references: [] });
      cursor = end + 1;
    },
    ondeclaration(_start, end) {
      markup("void", "", end + 1);
    },
    // `end` is the index of the `?` before the closing `>`.
    onprocessinginstruction(_start, end) {
      markup("void", "", end + 2);
    },
    onattribname: ignore,
    onattribdata: ignore,
    onattribentity: ignore,
    onattribend: ignore,
    onend: ignore,
  };

  const tokenizer = new Tokenizer({ xmlMode: true }, callbacks);
  tokenizer.write(source);
  tokenizer.end();
  // A tag still open at the very end is never reported; keep its bytes anyway.
  if (cursor < source.length) markup("void", "", source.length);
  return tokens;
}

/** A cut strictly inside a reference leaves a bare `&` in one chunk (the
 *  provider rejects it) and the reference's name spoken as a word in the
 *  next; a cut at its `&` or right after its `;` is fine. */
function referenceAround(references: Span[], index: number): Span | undefined {
  return references.find((span) => span.start < index && index < span.end);
}

/** Closing tags appended at flush count against the budget too, or a deep
 *  stack pushes a chunk past maxChunkSize. Negative once the chunk is full or
 *  the reopened tags alone exhaust the budget. */
function roomLeft(state: SsmlChunking): number {
  const closers = state.stack.reduce((n, tag) => n + state.sizeOf(tag.closer), 0);
  return state.budget - state.sizeOf(state.current) - closers;
}

/** Elements open at the cut are closed in this chunk and reopened in the
 *  next; a chunk with no speakable text is dropped. */
function flushChunk(state: SsmlChunking): void {
  const closers = [...state.stack]
    .reverse()
    .map((tag) => tag.closer)
    .join("");
  if (state.speakable) state.chunks.push(SPEAK_START + state.current + closers + SPEAK_END);
  state.current = state.stack.map((tag) => tag.raw).join("");
  state.speakable = false;
}

/** CDATA content is re-delimited in every chunk it lands in, so the
 *  delimiters count against each piece. */
function delimitersOf(token: TextToken): readonly [open: string, close: string] {
  return token.kind === "cdata" ? [CDATA_START, CDATA_END] : ["", ""];
}

function placeContent(state: SsmlChunking, token: TextToken, content: string): void {
  const [open, close] = delimitersOf(token);
  state.current += open + content + close;
  if (content.trim().length > 0) state.speakable = true;
}

/** A closer for the innermost open element closes it. One for an opener the
 *  nesting bailout dropped is swallowed, and an unmatched one in the input is
 *  dropped: either way the chunk stays well-formed. */
function closeElement(state: SsmlChunking, token: MarkupToken, raw: string): void {
  const innermost = state.stack[state.stack.length - 1];
  if (innermost !== undefined && innermost.name === token.name) {
    state.stack.pop();
    state.current += raw;
    return;
  }

  if (state.orphanedOpeners > 0) state.orphanedOpeners--;
}

/** Markup is kept verbatim and never cut. An opener is budgeted with its own
 *  eventual closer: admitting one must never leave the chunk with negative
 *  room, or the nesting bailout in makeRoom becomes reachable from perfectly
 *  valid input. */
function placeMarkup(state: SsmlChunking, token: MarkupToken): void {
  const raw = state.source.slice(token.start, token.end);
  const closer = token.kind === "open" ? `</${token.name}>` : "";
  const closerCost = closer === "" ? 0 : state.sizeOf(closer);
  if (state.current.length > 0 && state.sizeOf(raw) + closerCost > roomLeft(state)) {
    flushChunk(state);
  }

  if (token.kind === "close") {
    closeElement(state, token, raw);
    return;
  }

  if (token.kind === "open") state.stack.push({ name: token.name, raw, closer });
  state.current += raw;
}

/** Not even one code point fits at `pos`: the chunk is full, or a multi-byte
 *  char in byte mode. Budget is freed first; only an empty chunk with nothing
 *  to reopen overshoots. Returns where the content still to be placed starts
 *  afterwards. */
function makeRoom(state: SsmlChunking, token: TextToken, pos: number, room: number): number {
  if (state.speakable) {
    // flushChunk reopens the stack into `current`, so the retry keeps the
    // prosody wrappers intact.
    flushChunk(state);
    return pos;
  }

  if (state.current === "" && state.stack.length === 0) {
    // Pathological limit: an empty chunk cannot fit one code point, one
    // reference, or the CDATA delimiters; a tiny overshoot beats an infinite
    // loop. A reference is one atom: emitted whole in a chunk over the limit,
    // the SSML stays valid.
    const remaining = state.source.slice(pos, token.end);
    const forcedPrefix = pos + fittingPrefixLength(remaining, room, state.sizeOf);
    const forced = referenceAround(token.references, forcedPrefix)?.end ?? forcedPrefix;
    placeContent(state, token, state.source.slice(pos, forced));
    flushChunk(state);
    return forced;
  }

  // Pathological nesting: the reopened tags alone leave no room, so a flush
  // could never make progress. The elements open here are dropped (their
  // closers swallowed when they arrive): a chunk without those wrappers beats
  // an infinite loop.
  state.orphanedOpeners += state.stack.length;
  state.stack.length = 0;
  state.current = "";
  state.speakable = false;
  return pos;
}

/** Text is cut at the last space that fits, else where the budget ends, and
 *  never strictly inside a reference. */
function placeText(state: SsmlChunking, token: TextToken): void {
  const { source, sizeOf } = state;
  const [open, close] = delimitersOf(token);
  const delimitersCost = sizeOf(open) + sizeOf(close);

  // `pos` is the source index of the content still to be placed.
  let pos = token.start;
  while (pos < token.end) {
    const remaining = source.slice(pos, token.end);
    const room = roomLeft(state) - delimitersCost;
    if (sizeOf(remaining) <= room) break;

    // A cut inside a reference backs up to its `&`, which can leave nothing
    // that fits; makeRoom handles that too.
    const fitting = pos + fittingPrefixLength(remaining, room, sizeOf, false);
    const hard = referenceAround(token.references, fitting)?.start ?? fitting;
    if (hard === pos) {
      pos = makeRoom(state, token, pos, room);
      continue;
    }

    let cut = source.lastIndexOf(" ", hard);
    if (cut <= pos) cut = hard;
    placeContent(state, token, source.slice(pos, cut));
    pos = cut;
    flushChunk(state);
  }

  if (pos < token.end) placeContent(state, token, source.slice(pos, token.end));
}

function isTextToken(token: Token): token is TextToken {
  return token.kind === "text" || token.kind === "cdata";
}

/** Elements open at a cut are closed there and reopened in the next chunk, so
 *  a well-formed document chunks into well-formed `<speak>` documents. Chunks
 *  with no speakable text are dropped. */
export function chunkSSML(text: string, maxChunkSize = 5000, sizeOf: SizeOf = charSize): string[] {
  const source = text.trim();
  const tokens = tokenizeSsml(source);
  // Every chunk gets its own root element, so the document's is not content.
  const first = tokens[0];
  if (first?.kind === "open" && first.name === "speak") tokens.shift();
  const last = tokens[tokens.length - 1];
  if (last?.kind === "close" && last.name === "speak") tokens.pop();

  const state: SsmlChunking = {
    source,
    sizeOf,
    budget: Math.max(1, maxChunkSize - SPEAK_START.length - SPEAK_END.length),
    chunks: [],
    stack: [],
    orphanedOpeners: 0,
    current: "",
    speakable: false,
  };
  for (const token of tokens) {
    if (isTextToken(token)) placeText(state, token);
    else placeMarkup(state, token);
  }
  if (state.speakable) flushChunk(state);

  return state.chunks;
}

/** The result is plain text, not XML-escaped: escaping happens in the
 *  providers that embed text into SSML (escapeXml), or plain-text API paths
 *  would speak entity codes aloud. Complete SSML documents pass through
 *  untouched. A blank line survives as `\n\n`, which chunkText treats as a
 *  sentence end, so a heading or list item without end punctuation never
 *  merges into the sentence after it. */
export function sanitizeTextForSSML(text: string): string {
  if (!text) return "";
  if (isSSML(text)) return text;

  let sanitized = sanitizeHtml(text, {
    allowedTags: [],
    allowedAttributes: {},
  });

  sanitized = sanitized.replace(/\s+/g, (run) => (PARAGRAPH_BREAK.test(run) ? "\n\n" : " ")).trim();

  return he.decode(sanitized);
}
