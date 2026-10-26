import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  chunkSSML,
  chunkText,
  escapeXml,
  isSSML,
  sanitizeTextForSSML,
  stripSsmlTags,
  utf8ByteLength,
} from "@/lib/text/text";
import { buildSsml as azureSsml } from "@/providers/azure";
import { buildSsml as pollySsml } from "@/providers/polly";
import { fuzzRuns } from "../helpers/fuzz";
import {
  astralText,
  combiningClusters,
  joinerText,
  longWord,
  unicodeText,
  xmlSafeText,
} from "../helpers/unicode";
import { checkXml, normalizeLineEnds } from "../helpers/xml";

// Chunking over arbitrary unicode must keep every non-whitespace character once and in order, never cutting a
// surrogate pair, inside the limit except for an entity no chunk can fit. An SSML builder that returns a document
// must keep the input's text content.

/** At least 2 code units, so every single code point fits a chunk of its own. */
const charLimit = fc.integer({ min: 8, max: 200 });

/** At least 4 bytes, so every single code point fits a chunk of its own. */
const byteLimit = fc.integer({ min: 8, max: 200 });

/** Sanitized first, as the read-aloud and download paths do: the raw splitter drops tabs and line separators. */
const providerText = unicodeText.map(sanitizeTextForSSML).filter((text) => !isSSML(text));

function isHighSurrogate(code: number | undefined): boolean {
  return code !== undefined && code >= 0xd800 && code <= 0xdbff;
}
function isLowSurrogate(code: number | undefined): boolean {
  return code !== undefined && code >= 0xdc00 && code <= 0xdfff;
}

/** A chunk boundary inside a surrogate pair shows as a chunk that starts with
 *  a low surrogate or ends with a high one. */
function cutsSurrogatePair(chunk: string): boolean {
  return isLowSurrogate(chunk.charCodeAt(0)) || isHighSurrogate(chunk.charCodeAt(chunk.length - 1));
}

const isWhitespace = (char: string | undefined) => char !== undefined && /\s/u.test(char);

/** Whitespace at a piece boundary is unconstrained (the sentence splitter drops the gap between
 *  sentences, the word splitter trims at a cut); inside a piece the chunkers copy the text verbatim,
 *  so there every character, whitespace included, must match. */
function expectPiecesSpell(text: string, pieces: string[]): void {
  let pos = 0;
  const skipTextWhitespace = () => {
    while (isWhitespace(text[pos])) pos++;
  };
  for (const piece of pieces) {
    skipTextWhitespace();
    const inner = piece.trim();
    for (let i = 0; i < inner.length; i++, pos++) {
      if (text[pos] !== inner[i]) {
        throw new Error(
          `piece ${JSON.stringify(piece)} reads ${JSON.stringify(inner[i])} at ${i} where the text has ${JSON.stringify(text[pos])} at ${pos}`,
        );
      }
    }
  }
  skipTextWhitespace();
  if (pos !== text.length) {
    throw new Error(
      `pieces end at ${pos} of ${text.length}: ${JSON.stringify(text.slice(pos))} was dropped`,
    );
  }
}

function checkChunks(
  text: string,
  chunks: string[],
  limit: number,
  sizeOf: (chunk: string) => number,
): void {
  for (const chunk of chunks) {
    expect(sizeOf(chunk), `chunk over the limit: ${JSON.stringify(chunk)}`).toBeLessThanOrEqual(
      limit,
    );
    expect(chunk.trim(), "whitespace-only chunk").not.toBe("");
    expect(cutsSurrogatePair(chunk), `split pair in ${JSON.stringify(chunk)}`).toBe(false);
  }
  expectPiecesSpell(text, chunks);
}

describe("chunkText over unicode", () => {
  it("keeps every non-whitespace character once, in order, under a code-unit limit", () => {
    fc.assert(
      fc.property(providerText, charLimit, (text, limit) => {
        checkChunks(text, chunkText(text, limit), limit, (chunk) => chunk.length);
      }),
      fuzzRuns(300),
    );
  });

  it("keeps every non-whitespace character once, in order, under a UTF-8 byte limit", () => {
    fc.assert(
      fc.property(providerText, byteLimit, (text, limit) => {
        checkChunks(text, chunkText(text, limit, utf8ByteLength), limit, utf8ByteLength);
      }),
      fuzzRuns(300),
    );
  });

  it("splits one unbroken word of astral, CJK and combining characters without losing any", () => {
    const word = fc
      .oneof(longWord, astralText, combiningClusters, joinerText)
      .map(sanitizeTextForSSML);
    fc.assert(
      fc.property(word, charLimit, fc.boolean(), (text, limit, bytes) => {
        const sizeOf = bytes ? utf8ByteLength : (chunk: string) => chunk.length;
        checkChunks(text, chunkText(text, limit, sizeOf), limit, sizeOf);
      }),
      fuzzRuns(200),
    );
  });

  it("control: a chunk cut inside a surrogate pair is detected", () => {
    const [high, low] = ["\u{1f600}".charAt(0), "\u{1f600}".charAt(1)];
    expect(cutsSurrogatePair(`ab${high}`)).toBe(true);
    expect(cutsSurrogatePair(`${low}cd`)).toBe(true);
    expect(cutsSurrogatePair("ab\u{1f600}cd")).toBe(false);
  });

  it.each([
    ["hello world", ["helloworld"], "lost word boundary"],
    ["hello  world", ["hello world"], "shrunk whitespace run"],
    ["hello world", ["hello  world"], "grown whitespace run"],
    ["hello world", ["hello\tworld"], "changed whitespace"],
    ["hello world", ["hello", "wor"], "dropped tail"],
    ["hello world", ["hello", "world!"], "extra character"],
    ["hello world", ["world", "hello"], "reordered"],
    ["hello", ["hel", "hel", "lo"], "duplicated"], // typos: ignore
  ])("control: %s read as %j is rejected (%s)", (text, pieces) => {
    expect(() => expectPiecesSpell(text, pieces)).toThrow();
  });

  it("control: pieces that drop whitespace only at their boundaries are accepted", () => {
    expectPiecesSpell("Hello  world.  \n Next one!", ["Hello  world.", "Next", "one!"]);
    expectPiecesSpell("ab\u{1f600}cd", ["ab", "\u{1f600}c", "d"]);
  });
});

// --- SSML documents ---------------------------------------------------------------

const ssmlDocument: fc.Arbitrary<string> = fc
  .letrec<{ node: string; text: string }>((tie) => ({
    // Text nodes are escaped the way the SSML builders escape them, so the
    // chunker sees entities it must keep whole.
    text: xmlSafeText.map(escapeXml),
    node: fc.oneof(
      { depthSize: "small", withCrossShrink: true },
      tie("text"),
      fc.constant('<break time="300ms"/>'),
      fc
        .tuple(
          fc.constantFrom('prosody rate="slow"', 'emphasis level="strong"', "p", "s"),
          fc.array(tie("node"), { minLength: 1, maxLength: 3 }),
        )
        .map(([tag, children]) => `<${tag}>${children.join("")}</${tag.split(" ")[0]}>`),
    ),
  }))
  .node.chain((node) => fc.constant(`<speak>${node}</speak>`));

const ssmlLimit = fc.integer({ min: 60, max: 400 });

describe("chunkSSML over unicode", () => {
  it("emits well-formed <speak> chunks within the limit whose text content is the input's", () => {
    fc.assert(
      fc.property(ssmlDocument, ssmlLimit, (document, limit) => {
        const source = checkXml(document);
        if (!source.ok) throw new Error(`generator produced malformed SSML: ${source.reason}`);
        const chunks = chunkSSML(document, limit);
        const texts: string[] = [];
        for (const chunk of chunks) {
          expect(chunk.length, `chunk over the limit: ${chunk}`).toBeLessThanOrEqual(limit);
          expect(isSSML(chunk)).toBe(true);
          // A torn surrogate pair fails the oracle: a lone half is not an XML character.
          const parsed = checkXml(chunk);
          if (!parsed.ok) throw new Error(`${parsed.reason} in ${chunk}`);
          texts.push(parsed.text);
        }
        expectPiecesSpell(source.text, texts);
      }),
      fuzzRuns(300),
    );
  });

  // Body budget 2: an entity no chunk can fit comes out whole and over the limit, never torn.
  it('keeps an entity whole even when it cannot fit: chunkSSML("<speak>&amp;</speak>", 17)', () => {
    const chunks = chunkSSML("<speak>&amp;</speak>", 17);
    expect(chunks).toEqual(["<speak>&amp;</speak>"]);
    for (const chunk of chunks) {
      const parsed = checkXml(chunk);
      if (!parsed.ok) throw new Error(`${parsed.reason} in ${chunk}`);
      expect(parsed.text).toBe("&");
    }
  });
});

// --- SSML builders ------------------------------------------------------------------

const speed = fc
  .double({ min: 0.5, max: 3, noNaN: true })
  .map((value) => Math.round(value * 20) / 20);
const pitch = fc.integer({ min: -100, max: 100 }).map((value) => value / 10);
const volumeGainDb = fc.integer({ min: -16, max: 16 });
const prosody = fc.record({ speed, pitch, volumeGainDb });

const identifier = fc.stringMatching(/^[A-Za-z][A-Za-z0-9-]{0,30}$/);
const azureVoice = fc.constantFrom(
  "en-US-JennyNeural",
  "fr-FR-DeniseNeural",
  "zh-CN-XiaoxiaoNeural",
);
const language = fc.option(fc.constantFrom("en-US", "hi-IN", "zh-TW"), { nil: undefined });

describe("escapeXml and the SSML builders over unicode", () => {
  it("escapeXml yields text whose XML text content is the input", () => {
    fc.assert(
      fc.property(xmlSafeText, (text) => {
        const parsed = checkXml(`<speak>${escapeXml(text)}</speak>`);
        if (!parsed.ok) throw new Error(parsed.reason);
        expect(parsed.text).toBe(normalizeLineEnds(text));
      }),
      fuzzRuns(300),
    );
  });

  it("stripSsmlTags inverts wrapping plain text in escaped SSML, up to whitespace collapsing", () => {
    fc.assert(
      fc.property(xmlSafeText, (text) => {
        expect(stripSsmlTags(`<speak>${escapeXml(text)}</speak>`)).toBe(
          text.replace(/\s+/g, " ").trim(),
        );
      }),
      fuzzRuns(300),
    );
  });

  it("Azure buildSsml: well-formed, the input as text content, for plain text", () => {
    fc.assert(
      fc.property(
        xmlSafeText.filter((text) => !isSSML(text)),
        azureVoice,
        prosody,
        fc.option(identifier, { nil: undefined }),
        language,
        (text, voiceId, ranges, style, lang) => {
          const document = azureSsml(text, voiceId, { ...ranges, style, language: lang });
          const parsed = checkXml(document);
          if (!parsed.ok) throw new Error(`${parsed.reason} in ${document}`);
          expect(parsed.text).toBe(normalizeLineEnds(text));
          expect(document).toContain(`<voice name="${voiceId}">`);
        },
      ),
      fuzzRuns(300),
    );
  });

  it("Azure buildSsml: keeps the text content of an SSML input", () => {
    fc.assert(
      fc.property(ssmlDocument, azureVoice, prosody, (ssml, voiceId, ranges) => {
        const source = checkXml(ssml);
        if (!source.ok) throw new Error(source.reason);
        const parsed = checkXml(azureSsml(ssml, voiceId, ranges));
        if (!parsed.ok) throw new Error(parsed.reason);
        expect(parsed.text).toBe(source.text);
      }),
      fuzzRuns(200),
    );
  });

  it("Polly buildSsml: null for engines without SSML, else well-formed with the input as text content", () => {
    const model = fc.constantFrom("standard", "neural", "generative", "long-form");
    fc.assert(
      fc.property(
        xmlSafeText.filter((text) => !isSSML(text)),
        model,
        prosody,
        (text, engine, ranges) => {
          const document = pollySsml(text, engine, ranges);
          const neutral =
            ranges.speed === 1 &&
            ranges.volumeGainDb === 0 &&
            (ranges.pitch === 0 || engine !== "standard");
          if (engine === "generative" || engine === "long-form" || neutral) {
            expect(document).toBeNull();
            return;
          }
          if (document === null) throw new Error("expected an SSML document");
          const parsed = checkXml(document);
          if (!parsed.ok) throw new Error(`${parsed.reason} in ${document}`);
          expect(parsed.text).toBe(normalizeLineEnds(text));
        },
      ),
      fuzzRuns(300),
    );
  });

  it("Polly buildSsml: keeps the text content of an SSML input", () => {
    fc.assert(
      fc.property(
        ssmlDocument,
        fc.constantFrom("standard", "neural"),
        prosody,
        (ssml, engine, ranges) => {
          const source = checkXml(ssml);
          if (!source.ok) throw new Error(source.reason);
          const document = pollySsml(ssml, engine, ranges);
          if (document === null) throw new Error("SSML input must stay SSML");
          const parsed = checkXml(document);
          if (!parsed.ok) throw new Error(`${parsed.reason} in ${document}`);
          expect(parsed.text).toBe(source.text);
        },
      ),
      fuzzRuns(200),
    );
  });
});

describe("checkXml (the oracle) controls", () => {
  it.each([
    "<a><b></a>",
    "<a>x & y</a>",
    "<a>x < y</a>",
    '<a b="<"></a>',
    "<a>&bogus;</a>",
    "<a b=c></a>",
    '<a b="1" b="2"></a>',
    "<a></a><b></b>",
    "<a>",
    "x<a></a>",
    "<a></a>\u00a0",
    "<a>\u0001</a>",
    "<a>]]></a>",
    "<a>x</ a>",
    '<a\u00a0b="1">x</a>',
    "<a>\ud83d</a>",
    "<a><b>\ud83d</b><c>\ude00</c></a>",
    "<a>&#0;</a>",
    "<a>&#xD800;</a>",
    "<a>&#x110000;</a>",
  ])("rejects %s", (document) => {
    const parsed = checkXml(document);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).not.toBe("");
  });

  it("accepts nested elements, attributes and entities, decoding the text", () => {
    const parsed = checkXml(
      '<speak xml:lang="en-US"><voice name="x"><prosody rate="+10%">a &amp; b &#x1F600; &lt;c&gt;</prosody><break time="1s"/></voice></speak>',
    );
    expect(parsed).toEqual({ ok: true, text: "a & b \u{1f600} <c>" });
  });

  it("accepts ]]> in an attribute value, and XML whitespace around attributes and before >", () => {
    expect(checkXml("<a\n\tb=\"]]>\"\r c = '2' >x</a\n>")).toEqual({ ok: true, text: "x" });
  });

  it("reads CRLF and a lone CR as LF, the way every XML parser does on input", () => {
    expect(checkXml("<a>x\r\ny\rz</a>")).toEqual({ ok: true, text: "x\ny\nz" });
  });
});
