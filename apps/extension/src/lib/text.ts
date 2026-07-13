import he from "he";
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

/** True when the SSML fragment contains speakable text outside of tags. */
function hasSpeakableText(fragment: string): boolean {
  return stripTagsCompletely(fragment).trim().length > 0;
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

  const trimmed = text.trim();
  const openMatch = trimmed.match(/^<speak[^>]*>/);
  const content = openMatch ? trimmed.slice(openMatch[0].length, -SPEAK_END.length) : trimmed;

  const stack: OpenTag[] = [];
  // Openers dropped by the pathological-nesting bailout: their closers must
  // be swallowed later, or the chunk would carry unmatched closing tags.
  let orphanedOpeners = 0;
  let current = "";

  // Closing tags appended at flush count against the budget too; otherwise
  // a deep stack can push a chunk past maxChunkSize.
  const closersLength = () => stack.reduce((n, tag) => n + tag.name.length + 3, 0);

  const flush = () => {
    const closers = [...stack]
      .reverse()
      .map((tag) => `</${tag.name}>`)
      .join("");
    const body = current + closers;
    if (hasSpeakableText(body)) {
      chunks.push(SPEAK_START + body + SPEAK_END);
    }
    // The next chunk re-opens whatever elements are still open.
    current = stack.map((tag) => tag.raw).join("");
  };

  const regex = /(<[^>]*>|[^<]+)/g;
  let match: RegExpExecArray | null = regex.exec(content);

  while (match !== null) {
    const element = match[0];

    if (element.startsWith("<")) {
      const nameMatch = element.match(/^<\/?\s*([a-zA-Z][\w:-]*)/);
      const name = nameMatch?.[1] ?? "";
      const isClosing = element.startsWith("</");
      const opensElement =
        !isClosing &&
        !element.endsWith("/>") &&
        !element.startsWith("<!") &&
        !element.startsWith("<?");

      // Budget the tag AND (for openers) its own eventual closer: admitting
      // an opening tag must never leave the chunk with negative room, or the
      // bailout below becomes reachable from perfectly valid input.
      const closerCost = opensElement ? name.length + 3 : 0;
      if (
        current.length > 0 &&
        sizeOf(current) + sizeOf(element) + closersLength() + closerCost > wrapperBudget
      ) {
        flush();
      }

      if (isClosing) {
        if (stack.length > 0 && stack[stack.length - 1]?.name === name) {
          stack.pop();
          current += element;
        } else if (orphanedOpeners > 0) {
          // Closer for an opener the bailout dropped: swallow it; appending
          // would emit an unmatched closing tag.
          orphanedOpeners--;
        }
        // else: unmatched closer in the input; drop it, stay well-formed.
      } else {
        if (opensElement) stack.push({ name, raw: element });
        current += element;
      }
    } else {
      // Text node, which may itself exceed the remaining budget.
      let remaining = element;
      while (sizeOf(current) + sizeOf(remaining) + closersLength() > wrapperBudget) {
        const room = wrapperBudget - sizeOf(current) - closersLength();
        if (room <= 0) {
          // Pathological nesting: the reopened tags alone exhaust the budget.
          // Flush what exists, then DROP tag preservation for the remainder:
          // a chunk without prosody wrappers beats an infinite loop.
          if (hasSpeakableText(current)) {
            flush();
          }
          orphanedOpeners += stack.length;
          stack.length = 0;
          current = "";
          continue;
        }
        const hard = fittingPrefixLength(remaining, room, sizeOf, false);
        if (hard === 0) {
          // Not even one code point fits the remaining room (multi-byte char
          // in byte mode). Never overshoot; free budget instead:
          if (hasSpeakableText(current)) {
            // Speakable content queued: flush it. flush() reopens the stack
            // into `current`, so the next iteration retries with a nearly
            // full budget and the prosody wrappers INTACT.
            flush();
            continue;
          }
          if (current === "" && stack.length === 0) {
            // Pathological limit: an empty chunk can't fit one code point;
            // forced progress (tiny overshoot) beats an infinite loop.
            const forced = fittingPrefixLength(remaining, room, sizeOf);
            current += remaining.slice(0, forced);
            remaining = remaining.slice(forced);
            flush();
            continue;
          }
          // Tag-only content: the reopened tags alone leave no room, so a
          // flush could never make progress; drop tag preservation.
          orphanedOpeners += stack.length;
          stack.length = 0;
          current = "";
          continue;
        }
        let cut = remaining.lastIndexOf(" ", hard);
        if (cut <= 0) cut = hard;
        current += remaining.slice(0, cut);
        remaining = remaining.slice(cut);
        flush();
      }
      current += remaining;
    }

    match = regex.exec(content);
  }

  if (hasSpeakableText(current)) flush();

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
