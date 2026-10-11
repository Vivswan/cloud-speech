import { parseXml, XmlError } from "@rgrove/parse-xml";

// A conforming XML parser as the well-formedness oracle for the SSML the providers build. Deliberately not
// DOMParser: happy-dom's parser is lenient about some malformed input (an unescaped `&` in text, for one), and a
// lenient oracle would pass exactly the documents a real provider rejects.

export type XmlCheck = { ok: true; text: string } | { ok: false; reason: string };

/** True for a code point XML 1.0 forbids anywhere in a document, even escaped; a lone surrogate counts,
 *  since half of a torn pair is not a character. */
export function isXmlIllegalCodePoint(codePoint: number): boolean {
  if (codePoint < 0x20) return codePoint !== 0x9 && codePoint !== 0xa && codePoint !== 0xd;
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) return true;
  return codePoint === 0xfffe || codePoint === 0xffff || codePoint > 0x10ffff;
}

/** The line-end normalization every XML parser applies on input (XML 1.0
 *  section 2.11): CRLF and a lone CR both read as LF. The text content a
 *  provider sees is the normalized one, so compare against this. */
export function normalizeLineEnds(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function checkXml(document: string): XmlCheck {
  try {
    return { ok: true, text: parseXml(document).text };
  } catch (error) {
    if (error instanceof XmlError) return { ok: false, reason: error.message };
    throw error;
  }
}
