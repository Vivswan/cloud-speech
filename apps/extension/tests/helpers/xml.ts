// A strict XML well-formedness check for the SSML documents the providers
// build, returning the decoded text content. Deliberately not DOMParser: the
// happy-dom parser is lenient about some malformed input (an unescaped `&`
// in text, for one), and a lenient oracle would pass exactly the documents
// a real provider rejects.

export type XmlCheck = { ok: true; text: string } | { ok: false; reason: string };

const NAME = /^[A-Za-z_:][\w.:-]*$/;
const ENTITY = /^&(amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+);/;
/** XML whitespace (production S) is only these four; `\s` would also admit
 *  a no-break space, which no XML parser accepts between attributes. */
const S = " \\t\\r\\n";
const ATTRIBUTE = new RegExp(`^[${S}]+([^${S}=]+)[${S}]*=[${S}]*("([^"<]*)"|'([^'<]*)')`);
const CLOSING_TAG = new RegExp(`^/([^${S}/>]+)[${S}]*$`);
const ONLY_SPACE = new RegExp(`^[${S}]*$`);
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** True for a code point XML 1.0 forbids anywhere in a document, even
 *  escaped: the C0 controls other than tab, newline and carriage return, a
 *  surrogate on its own (half of a torn pair is not a character), the two
 *  noncharacters at the top of the BMP, and anything past U+10FFFF. */
export function isXmlIllegalCodePoint(codePoint: number): boolean {
  if (codePoint < 0x20) return codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  return codePoint === 0xfffe || codePoint === 0xffff || codePoint > 0x10ffff;
}

function firstIllegalCodePoint(document: string): number | undefined {
  for (const char of document) {
    const codePoint = char.codePointAt(0) as number;
    if (isXmlIllegalCodePoint(codePoint)) return codePoint;
  }
  return undefined;
}

/** A character reference may only name a legal XML character. */
function isLegalReference(codePoint: number): boolean {
  return Number.isInteger(codePoint) && !isXmlIllegalCodePoint(codePoint);
}

/** The line-end normalization every XML parser applies on input (XML 1.0
 *  section 2.11): CRLF and a lone CR both read as LF. The text content a
 *  provider sees is the normalized one, so compare against this. */
export function normalizeLineEnds(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

class XmlSyntaxError extends Error {}

function fail(reason: string): never {
  throw new XmlSyntaxError(reason);
}

/** Decode character data (text or an attribute value), where every `&` must
 *  start a known entity; text may not contain `]]>` (an attribute value may).
 *  A raw `<` never reaches here: in text it starts a tag, and the attribute
 *  pattern excludes it. */
function decodeCharData(raw: string, where: "text" | `attribute ${string}`): string {
  if (where === "text" && raw.includes("]]>")) fail("]]> in text");
  let out = "";
  let i = 0;
  while (i < raw.length) {
    const char = raw[i] as string;
    if (char !== "&") {
      out += char;
      i++;
      continue;
    }
    const match = ENTITY.exec(raw.slice(i));
    if (!match) fail(`bare & in ${where} at ${JSON.stringify(raw.slice(i, i + 8))}`);
    const entity = match[1] as string;
    if (entity.startsWith("#")) {
      const codePoint = entity.startsWith("#x")
        ? Number.parseInt(entity.slice(2), 16)
        : Number(entity.slice(1));
      if (!isLegalReference(codePoint)) fail(`reference &${entity}; to an illegal character`);
      out += String.fromCodePoint(codePoint);
    } else {
      out += NAMED_ENTITIES[entity] as string;
    }
    i += match[0].length;
  }
  return out;
}

/** Parse `name attr="value" ...` (already stripped of the angle brackets and
 *  any closing slash) and return the element name. */
function parseTagBody(body: string): string {
  const nameMatch = /^[^ \t\r\n/>]+/.exec(body);
  const name = nameMatch?.[0] ?? "";
  if (!NAME.test(name)) fail(`bad element name ${JSON.stringify(name)}`);
  let rest = body.slice(name.length);
  const seen = new Set<string>();
  while (!ONLY_SPACE.test(rest)) {
    const attr = ATTRIBUTE.exec(rest);
    if (!attr) fail(`bad attribute syntax in <${name}${rest}>`);
    const attrName = attr[1] as string;
    if (!NAME.test(attrName)) fail(`bad attribute name ${JSON.stringify(attrName)}`);
    if (seen.has(attrName)) fail(`duplicate attribute ${attrName} on <${name}>`);
    seen.add(attrName);
    decodeCharData(attr[3] ?? attr[4] ?? "", `attribute ${attrName}`);
    rest = rest.slice(attr[0].length);
  }
  return name;
}

/** The index just past the `>` closing the tag that opens at `start`, with
 *  quoted attribute values allowed to contain `>`. */
function tagEnd(document: string, start: number): number {
  let quote: string | null = null;
  for (let i = start + 1; i < document.length; i++) {
    const char = document[i] as string;
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i + 1;
    }
  }
  return fail("unterminated tag");
}

/** Check that `document` is a well-formed XML document with exactly one root
 *  element and return its decoded text content. Comments, processing
 *  instructions, CDATA and doctypes are rejected: the SSML builders never
 *  emit them, so accepting them would only widen the oracle. */
export function checkXml(rawDocument: string): XmlCheck {
  try {
    const document = normalizeLineEnds(rawDocument);
    const illegal = firstIllegalCodePoint(document);
    if (illegal !== undefined) fail(`illegal XML character U+${illegal.toString(16)}`);
    const stack: string[] = [];
    let roots = 0;
    let text = "";
    let i = 0;
    while (i < document.length) {
      const next = document.indexOf("<", i);
      const chunk = document.slice(i, next === -1 ? document.length : next);
      if (chunk.length > 0) {
        if (stack.length === 0 && !ONLY_SPACE.test(chunk)) fail("text outside the root element");
        text += decodeCharData(chunk, "text");
      }
      if (next === -1) break;
      const end = tagEnd(document, next);
      const inner = document.slice(next + 1, end - 1);
      if (inner.startsWith("!") || inner.startsWith("?")) fail("markup declaration not allowed");
      if (inner.startsWith("/")) {
        const closing = CLOSING_TAG.exec(inner);
        if (!closing) fail(`bad closing tag <${inner}>`);
        const name = closing[1] as string;
        const open = stack.pop();
        if (open === undefined) fail(`closing </${name}> with nothing open`);
        if (open !== name) fail(`</${name}> closes <${open}>`);
      } else {
        const selfClosing = inner.endsWith("/");
        const name = parseTagBody(selfClosing ? inner.slice(0, -1) : inner);
        if (stack.length === 0) {
          roots++;
          if (roots > 1) fail("more than one root element");
        }
        if (!selfClosing) stack.push(name);
      }
      i = end;
    }
    if (stack.length > 0) fail(`unclosed <${stack[stack.length - 1]}>`);
    if (roots === 0) fail("no root element");
    return { ok: true, text };
  } catch (error) {
    if (error instanceof XmlSyntaxError) return { ok: false, reason: error.message };
    throw error;
  }
}
