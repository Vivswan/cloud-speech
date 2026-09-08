import he from "he";
import { Tokenizer, type TokenizerCallbacks } from "htmlparser2";
import sanitizeHtml from "sanitize-html";
import model from "wink-eng-lite-web-model";
import winkNLP from "wink-nlp";

const nlp = winkNLP(model);

const SPEAK_START = "<speak>";
const SPEAK_END = "</speak>";

/** True when the text is a complete `<speak>...</speak>` SSML document. */
export function isSSML(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("<speak") && trimmed.endsWith(SPEAK_END);
}

/**
 * Escape XML special characters for safe embedding inside an SSML document.
 * Providers call this when wrapping PLAIN text in SSML tags; plain-text API
 * paths (Polly TEXT type, Google text input, OpenAI) must NOT escape.
 */
export function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Remove EVERY tag-shaped sequence, applying the replacement to a fixpoint:
 * a single-pass `replace` can leave a new tag behind (`<scr<x>ipt>`), which
 * CodeQL rightly flags. Terminates because every pass strictly shrinks the
 * string. TTS output is not a DOM, but the checks that gate speakability
 * must not be foolable either.
 */
function stripTagsCompletely(text: string, replacement = ""): string {
  let previous: string;
  let current = text;
  do {
    previous = current;
    current = current.replace(/<[^>]*>/g, replacement);
  } while (current !== previous);
  return current;
}

/**
 * Strip all SSML/XML markup from a document and decode entities so the text
 * can be sent to a plain-text-only synthesis path without the tags being
 * spoken aloud.
 */
export function stripSsmlTags(text: string): string {
  return he.decode(stripTagsCompletely(text, " ").replace(/\s+/g, " ").trim());
}

/** Measures a chunk against a provider limit (UTF-16 code units by default). */
export type SizeOf = (text: string) => number;

const charSize: SizeOf = (text) => text.length;

const utf8Encoder = new TextEncoder();

/** UTF-8 byte measure for providers whose limits are BYTES, not characters. */
export const utf8ByteLength: SizeOf = (text) => utf8Encoder.encode(text).length;

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/**
 * Largest UTF-16 index `i` such that `sizeOf(text.slice(0, i))` fits within
 * `limit`, never splitting a surrogate pair. With `forceProgress` (default)
 * it always advances by at least one code point (accepting a tiny overshoot
 * under a pathological limit); pass false to get 0 when nothing fits, so the
 * caller can free up budget instead of exceeding it.
 */
function fittingPrefixLength(
  text: string,
  limit: number,
  sizeOf: SizeOf,
  forceProgress = true,
): number {
  let index: number;
  if (sizeOf === charSize) {
    index = Math.min(limit, text.length);
  } else {
    // sizeOf over prefixes is monotonic: binary search the largest fit.
    let low = 0;
    let high = text.length;
    while (low < high) {
      const mid = low + Math.ceil((high - low) / 2);
      if (sizeOf(text.slice(0, mid)) <= limit) low = mid;
      else high = mid - 1;
    }
    index = low;
  }

  // Never cut between a high and low surrogate.
  if (
    index > 0 &&
    index < text.length &&
    isHighSurrogate(text.charCodeAt(index - 1)) &&
    isLowSurrogate(text.charCodeAt(index))
  ) {
    index--;
  }
  if (index <= 0) {
    if (!forceProgress) return 0;
    index = isHighSurrogate(text.charCodeAt(0)) && isLowSurrogate(text.charCodeAt(1) ?? 0) ? 2 : 1;
  }
  return index;
}

/**
 * Split text into synthesizable chunks no larger than `maxChunkSize` as
 * measured by `sizeOf` (UTF-16 code units by default; pass `utf8ByteLength`
 * for byte-limited providers). Plain text splits on sentence boundaries
 * (wink-nlp); a single sentence longer than the limit is further split on
 * word boundaries, never inside a surrogate pair. SSML splits into
 * tag-balanced `<speak>`-wrapped windows.
 */
export function chunkText(text: string, maxChunkSize = 5000, sizeOf: SizeOf = charSize): string[] {
  if (isSSML(text)) return chunkSSML(text, maxChunkSize, sizeOf);

  const sentences: string[] = nlp.readDoc(text).sentences().out();
  const chunks: string[] = [];
  for (const sentence of sentences) {
    if (sizeOf(sentence) <= maxChunkSize) {
      if (sentence.trim()) chunks.push(sentence);
      continue;
    }
    // Oversized sentence: split on word boundaries within the limit.
    let remaining = sentence;
    while (sizeOf(remaining) > maxChunkSize) {
      const hard = fittingPrefixLength(remaining, maxChunkSize, sizeOf);
      let cut = remaining.lastIndexOf(" ", hard);
      if (cut <= 0) cut = hard;
      chunks.push(remaining.slice(0, cut));
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining.trim()) chunks.push(remaining);
  }
  return chunks;
}

interface OpenTag {
  name: string;
  raw: string;
  closer: string;
}

const CDATA_START = "<![CDATA[";
const CDATA_END = "]]>";

/** The `[start, end)` span of a token in the source document. */
interface Span {
  start: number;
  end: number;
}

/** A run of character data that chunk cuts may fall inside of: text, with
 *  the spans of the character and entity references a cut must never land
 *  in, or the content of a CDATA section, which every chunk it is cut
 *  across re-delimits. */
interface TextToken extends Span {
  kind: "text" | "cdata";
  references: Span[];
}

/** One `<...>` of markup, kept verbatim and never cut. Only an opening tag
 *  goes on the stack; a closer pops it; everything else (self-closing
 *  elements, comments, processing instructions) passes straight through. */
interface MarkupToken extends Span {
  kind: "open" | "close" | "void";
  name: string;
}

type Token = TextToken | MarkupToken;

/**
 * Tokenize an SSML document into source spans with htmlparser2's tokenizer
 * in XML mode. It reports positions rather than building a tree, so every
 * chunk stays an exact slice of the user's SSML. It is also lenient by
 * design: a bare `&` or `<` stays character data instead of raising, so
 * malformed SSML reaches the provider unchanged and is rejected there, just
 * as it would be unchunked.
 */
function tokenizeSsml(source: string): Token[] {
  const tokens: Token[] = [];
  // Every token starts where the previous one ended, so the callbacks only
  // have to supply each token's end.
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
    // The content ends `offset` before the `>`. It is cut like text and every
    // chunk adds its own delimiters, so those are not part of the token. An
    // empty section has nothing to cut, and one left open at the end of the
    // input must not be closed for the author: both stay raw bytes.
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

/**
 * The reference that `index` falls strictly inside of, or undefined when a
 * cut at `index` tears none. A cut right before the `&` or right after the
 * `;` is fine; anywhere between leaves a bare `&` in one chunk (malformed
 * SSML, the provider rejects it) and the reference's name spoken as a word
 * in the next.
 */
function referenceAround(references: Span[], index: number): Span | undefined {
  return references.find((span) => span.start < index && index < span.end);
}

/**
 * Split an SSML document into `<speak>`-wrapped chunks without breaking tags.
 * Tracks the open-tag stack: when a window closes mid-element, the open tags
 * are CLOSED at the chunk end and REOPENED at the start of the next chunk so
 * every emitted chunk is a well-formed document. Chunks with no speakable
 * text are dropped.
 */
export function chunkSSML(text: string, maxChunkSize = 5000, sizeOf: SizeOf = charSize): string[] {
  const chunks: string[] = [];
  // Clamped to >= 1: a budget of 0 or less would make the empty-state
  // iteration spin without ever reaching the forced-progress machinery.
  const wrapperBudget = Math.max(1, maxChunkSize - SPEAK_START.length - SPEAK_END.length);

  const source = text.trim();
  const tokens = tokenizeSsml(source);
  // Every chunk gets its own root element, so the document's is not content.
  const first = tokens[0];
  if (first?.kind === "open" && first.name === "speak") tokens.shift();
  const last = tokens[tokens.length - 1];
  if (last?.kind === "close" && last.name === "speak") tokens.pop();

  const stack: OpenTag[] = [];
  // Openers dropped by the pathological-nesting bailout: their closers must
  // be swallowed later, or the chunk would carry unmatched closing tags.
  let orphanedOpeners = 0;
  let current = "";
  // Whether `current` holds text beyond whitespace; tags alone are not worth
  // a request.
  let speakable = false;

  // Closing tags appended at flush count against the budget too; otherwise
  // a deep stack can push a chunk past maxChunkSize.
  const closersLength = () => stack.reduce((n, tag) => n + sizeOf(tag.closer), 0);

  const flush = () => {
    const closers = [...stack]
      .reverse()
      .map((tag) => tag.closer)
      .join("");
    if (speakable) {
      chunks.push(SPEAK_START + current + closers + SPEAK_END);
    }
    // The next chunk re-opens whatever elements are still open.
    current = stack.map((tag) => tag.raw).join("");
    speakable = false;
  };

  for (const token of tokens) {
    const raw = source.slice(token.start, token.end);

    if (token.kind !== "text" && token.kind !== "cdata") {
      const closer = token.kind === "open" ? `</${token.name}>` : "";

      // Budget the tag AND (for openers) its own eventual closer: admitting
      // an opening tag must never leave the chunk with negative room, or the
      // bailout below becomes reachable from perfectly valid input.
      const closerCost = closer === "" ? 0 : sizeOf(closer);
      if (
        current.length > 0 &&
        sizeOf(current) + sizeOf(raw) + closersLength() + closerCost > wrapperBudget
      ) {
        flush();
      }

      if (token.kind === "close") {
        if (stack.length > 0 && stack[stack.length - 1]?.name === token.name) {
          stack.pop();
          current += raw;
        } else if (orphanedOpeners > 0) {
          // Closer for an opener the bailout dropped: swallow it; appending
          // would emit an unmatched closing tag.
          orphanedOpeners--;
        }
        // else: unmatched closer in the input; drop it, stay well-formed.
      } else {
        if (token.kind === "open") stack.push({ name: token.name, raw, closer });
        current += raw;
      }
      continue;
    }

    // Character data, which may itself exceed the remaining budget. CDATA
    // content is re-delimited in every chunk it lands in, so the delimiters
    // count against each piece. Tags alone are not worth a request, so only
    // text beyond whitespace makes the chunk speakable.
    const [open, close] = token.kind === "cdata" ? [CDATA_START, CDATA_END] : ["", ""];
    const delimitersCost = sizeOf(open) + sizeOf(close);
    const place = (content: string) => {
      current += open + content + close;
      if (content.trim().length > 0) speakable = true;
    };

    // `pos` is the source index of the content still to be placed.
    let pos = token.start;
    while (
      pos < token.end &&
      sizeOf(current) + delimitersCost + sizeOf(source.slice(pos, token.end)) + closersLength() >
        wrapperBudget
    ) {
      const remaining = source.slice(pos, token.end);
      // Negative once the chunk is full or the reopened tags alone exhaust
      // the budget; nothing fits then, and the zero branch below decides.
      const room = wrapperBudget - sizeOf(current) - closersLength() - delimitersCost;
      // Never cut inside a reference: back the cut up to its `&`. Backing up
      // can leave nothing that fits, which the zero branch below handles.
      const fitting = pos + fittingPrefixLength(remaining, room, sizeOf, false);
      const hard = referenceAround(token.references, fitting)?.start ?? fitting;
      if (hard === pos) {
        // Not even one code point fits the remaining room (the chunk is
        // full, or a multi-byte char in byte mode). Never overshoot; free
        // budget instead:
        if (speakable) {
          // Speakable content queued: flush it. flush() reopens the stack
          // into `current`, so the next iteration retries with a nearly
          // full budget and the prosody wrappers INTACT.
          flush();
          continue;
        }
        if (current === "" && stack.length === 0) {
          // Pathological limit: an empty chunk can't fit one code point, one
          // reference, or the CDATA delimiters; forced progress (tiny
          // overshoot) beats an infinite loop. A reference is one atom here:
          // emitting it whole in a chunk over the limit is the one outcome
          // that keeps the SSML valid.
          const forcedPrefix = pos + fittingPrefixLength(remaining, room, sizeOf);
          const forced = referenceAround(token.references, forcedPrefix)?.end ?? forcedPrefix;
          place(source.slice(pos, forced));
          pos = forced;
          flush();
          continue;
        }
        // Pathological nesting: the reopened tags alone leave no room, so a
        // flush could never make progress. DROP tag preservation for the
        // remainder: a chunk without prosody wrappers beats an infinite loop.
        orphanedOpeners += stack.length;
        stack.length = 0;
        current = "";
        speakable = false;
        continue;
      }
      let cut = source.lastIndexOf(" ", hard);
      if (cut <= pos) cut = hard;
      place(source.slice(pos, cut));
      pos = cut;
      flush();
    }
    if (pos < token.end) place(source.slice(pos, token.end));
  }

  if (speakable) flush();

  return chunks;
}

/**
 * Sanitize arbitrary page text for synthesis: strips HTML tags and decodes
 * HTML entities. The result is PLAIN text: XML escaping happens inside the
 * providers that embed text into SSML (see escapeXml), never globally, so
 * plain-text API paths don't speak entity codes aloud.
 * Complete SSML documents pass through untouched.
 */
export function sanitizeTextForSSML(text: string): string {
  if (!text) return "";
  if (isSSML(text)) return text;

  let sanitized = sanitizeHtml(text, {
    allowedTags: [],
    allowedAttributes: {},
  });

  sanitized = sanitized
    .replace(/\s+/g, " ")
    .replace(/\n\s*\n/g, "\n")
    .trim();

  return he.decode(sanitized);
}
