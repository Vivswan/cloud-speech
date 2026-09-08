import { describe, expect, it } from "vitest";
import {
  chunkSSML,
  chunkText,
  escapeXml,
  isSSML,
  sanitizeTextForSSML,
  stripSsmlTags,
  utf8ByteLength,
} from "@/lib/text";
import { checkXml } from "../helpers/xml";

describe("isSSML", () => {
  it("detects complete speak documents", () => {
    expect(isSSML("<speak>Hi</speak>")).toBe(true);
    expect(isSSML("  <speak>Hi</speak>  ")).toBe(true);
    expect(isSSML("Hi")).toBe(false);
    expect(isSSML("<speak>Hi")).toBe(false);
  });
});

describe("chunkText", () => {
  it("splits plain text into sentences", () => {
    const chunks = chunkText("First sentence. Second sentence! Third?");
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toContain("First");
  });

  it("routes SSML to the SSML chunker", () => {
    const chunks = chunkText("<speak>Hello there</speak>");
    expect(chunks).toEqual(["<speak>Hello there</speak>"]);
  });
});

describe("chunkSSML", () => {
  it("splits long SSML into wrapped chunks without breaking tags", () => {
    const body = `<prosody rate="150%">${"word ".repeat(50)}</prosody>`.repeat(5);
    const chunks = chunkSSML(`<speak>${body}</speak>`, 600);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.startsWith("<speak>")).toBe(true);
      expect(chunk.endsWith("</speak>")).toBe(true);
      // No tag may be split across chunks.
      expect((chunk.match(/</g) ?? []).length).toBe((chunk.match(/>/g) ?? []).length);
    }
  });
});

describe("sanitizeTextForSSML", () => {
  it("passes complete SSML through untouched", () => {
    expect(sanitizeTextForSSML("<speak>Hi <break/></speak>")).toBe("<speak>Hi <break/></speak>");
  });

  it("strips HTML and decodes entities WITHOUT escaping (plain-text output)", () => {
    const result = sanitizeTextForSSML("<b>Tom &amp; Jerry</b> <script>x()</script>");
    expect(result).not.toContain("<b>");
    expect(result).not.toContain("<script>");
    // Plain text: providers escape when embedding into SSML, plain-text APIs
    // must receive the literal ampersand (never spoken entity codes).
    expect(result).toContain("Tom & Jerry");
  });

  it("escapeXml escapes the five XML special characters", () => {
    expect(escapeXml(`Tom & "Jerry" <'>`)).toBe("Tom &amp; &quot;Jerry&quot; &lt;&apos;&gt;");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeTextForSSML("")).toBe("");
  });
});

describe("chunkText limits", () => {
  it("splits a single oversized sentence on word boundaries", () => {
    const long = `word ${"blah ".repeat(300)}end.`;
    const chunks = chunkText(long, 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(500);
  });

  it("keeps ASCII character-based chunking unchanged by default", () => {
    const long = `word ${"blah ".repeat(300)}end.`;
    // For pure ASCII, bytes == chars, so both measures agree exactly.
    expect(chunkText(long, 500, utf8ByteLength)).toEqual(chunkText(long, 500));
  });
});

describe("chunkText byte measurement", () => {
  const isLoneSurrogateEdge = (chunk: string) => {
    const first = chunk.charCodeAt(0);
    const last = chunk.charCodeAt(chunk.length - 1);
    return (
      (first >= 0xdc00 && first <= 0xdfff) || // starts with a low surrogate
      (last >= 0xd800 && last <= 0xdbff) // ends with a high surrogate
    );
  };

  it("keeps emoji text under the BYTE limit without splitting surrogate pairs", () => {
    // Each emoji is 2 UTF-16 units but 4 UTF-8 bytes; no spaces, so hard cuts are forced.
    const emoji = "😀".repeat(500); // 2000 bytes as one "sentence"
    const chunks = chunkText(emoji, 101, utf8ByteLength);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(utf8ByteLength(chunk)).toBeLessThanOrEqual(101);
      expect(isLoneSurrogateEdge(chunk)).toBe(false);
    }
    // Nothing lost: reassembly preserves every emoji.
    expect(chunks.join("")).toBe(emoji);
  });

  it("keeps CJK text under the BYTE limit", () => {
    const cjk = "谢谢你".repeat(200); // 3 bytes per char, 1800 bytes, no spaces
    const chunks = chunkText(cjk, 300, utf8ByteLength);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(utf8ByteLength(chunk)).toBeLessThanOrEqual(300);
    }
    expect(chunks.join("")).toBe(cjk);
  });

  it("never splits a surrogate pair even with the default character measure", () => {
    const emoji = "😀".repeat(400);
    const chunks = chunkText(emoji, 101); // odd limit would land mid-pair naively
    for (const chunk of chunks) {
      expect(isLoneSurrogateEdge(chunk)).toBe(false);
      expect(chunk.length).toBeLessThanOrEqual(101);
    }
    expect(chunks.join("")).toBe(emoji);
  });

  it("chunks SSML by bytes too", () => {
    const body = `<prosody rate="150%">${"谢谢你 ".repeat(120)}</prosody>`;
    const chunks = chunkText(`<speak>${body}</speak>`, 400, utf8ByteLength);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(utf8ByteLength(chunk)).toBeLessThanOrEqual(400);
      expect(chunk.startsWith("<speak>")).toBe(true);
      expect(chunk.endsWith("</speak>")).toBe(true);
    }
  });
});

describe("stripSsmlTags", () => {
  it("removes markup and decodes entities for plain-text-only paths", () => {
    expect(stripSsmlTags("<speak>Hi <break/> there</speak>")).toBe("Hi there");
    expect(
      stripSsmlTags('<speak>Tom &amp; <emphasis level="strong">Jerry</emphasis></speak>'),
    ).toBe("Tom & Jerry");
  });
});

describe("chunkSSML balance", () => {
  it("closes and reopens tags across chunk boundaries (every chunk well-formed)", () => {
    const body = `<prosody rate="150%">${"word ".repeat(400)}</prosody>`;
    const chunks = chunkSSML(`<speak>${body}</speak>`, 400);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      const opens = (chunk.match(/<prosody/g) ?? []).length;
      const closes = (chunk.match(/<\/prosody>/g) ?? []).length;
      expect(opens).toBe(closes);
      expect(chunk.startsWith("<speak>")).toBe(true);
      expect(chunk.endsWith("</speak>")).toBe(true);
    }
  });
});

describe("chunkSSML boundary budgeting", () => {
  it("never exceeds maxChunkSize or emits unmatched closers when an opening tag lands near the budget", () => {
    // Craft input where the opening tag is admitted within closer-length of
    // the wrapper budget; the old code let room go negative, cleared the
    // stack, and then appended the (now unmatched) closing tag.
    const inner = `<prosody rate="150%" pitch="+2%" volume="+3dB">${"x".repeat(500)}</prosody>`;
    const body = `${"pad ".repeat(20)}${inner}`.repeat(6);
    for (const max of [120, 150, 200, 260]) {
      const chunks = chunkSSML(`<speak>${body}</speak>`, max);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(max);
        // Every tag balanced: no orphan closers, no unclosed openers.
        const opens = (chunk.match(/<prosody/g) ?? []).length;
        const closes = (chunk.match(/<\/prosody>/g) ?? []).length;
        expect(closes).toBe(opens);
      }
    }
  });
});

describe("chunkSSML entities", () => {
  /** Every chunk is well-formed XML within `limit`; their decoded text, joined,
   *  is `text`. Whitespace at a cut is kept by chunkSSML, so the join is exact. */
  function expectEntitySafe(chunks: string[], limit: number, text: string): void {
    const texts: string[] = [];
    for (const chunk of chunks) {
      expect(chunk.length, `chunk over the limit: ${chunk}`).toBeLessThanOrEqual(limit);
      const parsed = checkXml(chunk);
      if (!parsed.ok) throw new Error(`${parsed.reason} in ${chunk}`);
      texts.push(parsed.text);
    }
    expect(texts.join("")).toBe(text);
  }

  it("emits an entity that fits no chunk whole, over the limit, rather than torn", () => {
    // Budget 2: the entity is the oversize atom, treated like a lone code point.
    expect(chunkSSML("<speak>&amp;</speak>", 17)).toEqual(["<speak>&amp;</speak>"]);
  });

  it.each([
    ["&amp;", "&"],
    ["&#38;", "&"],
    ["&#x1F600;", "\u{1f600}"],
    ["&lt;", "<"],
    ["&quot;", '"'],
  ])("keeps the %s reference whole across every cut position", (entity, decoded) => {
    // No spaces, so the cut is the hard one. The sweep starts where the
    // longest reference fits an empty chunk and runs past the padding, so the
    // cut lands on every code unit of the reference along the way.
    const body = `${"x".repeat(10)}${entity}${"y".repeat(10)}`;
    for (let limit = 26; limit <= 50; limit++) {
      expectEntitySafe(
        chunkSSML(`<speak>${body}</speak>`, limit),
        limit,
        "x".repeat(10) + decoded + "y".repeat(10),
      );
    }
  });

  it("keeps a surrogate pair and an adjacent entity whole at the boundary", () => {
    const emoji = "\u{1f600}".repeat(6);
    const body = `${emoji}&amp;${emoji}`;
    for (let limit = 20; limit <= 45; limit++) {
      expectEntitySafe(chunkSSML(`<speak>${body}</speak>`, limit), limit, `${emoji}&${emoji}`);
    }
  });

  it("control: the oracle rejects the torn entity the splitter used to emit", () => {
    expect(checkXml("<speak>&a</speak>").ok).toBe(false);
    expect(checkXml("<speak>mp</speak>")).toEqual({ ok: true, text: "mp" });
  });
});

describe("chunkSSML tokenizing", () => {
  /** The chunks' bodies, read in order, spell the document's body: a chunk cut
   *  keeps whitespace, so the join is exact. */
  function joinBodies(chunks: string[]): string {
    return chunks.map((chunk) => chunk.slice("<speak>".length, -"</speak>".length)).join("");
  }

  it.each([
    [
      "a bare & and <, a reference without its ; and an unknown one",
      "<speak>a & b < c &amp d &bogus; e</speak>",
      "a & b < c &amp d &bogus; e",
    ],
    // The open quote or section swallows the root closer, so that is part of the body kept.
    [
      "an attribute value never closed",
      '<speak>hello <prosody rate="x</speak>',
      'hello <prosody rate="x</speak>',
    ],
    [
      "a CDATA section never closed",
      "<speak>hello<![CDATA[abc</speak>",
      "hello<![CDATA[abc</speak>",
    ],
  ])("passes malformed SSML through verbatim instead of throwing: %s", (_case, document, body) => {
    // Character data stays character data and markup left open at the end
    // keeps its bytes, so the provider sees what it would have unchunked.
    expect(chunkSSML(document)).toEqual([`<speak>${body}</speak>`]);
    for (let limit = 20; limit <= 30; limit++) {
      const chunks = chunkSSML(document, limit);
      expect(chunks.length).toBeGreaterThan(0);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(limit);
        // Every chunk body is a verbatim slice of the document's.
        expect(body).toContain(chunk.slice("<speak>".length, -"</speak>".length));
      }
    }
  });

  it("keeps a > inside an attribute value from ending the tag at any cut", () => {
    const body = `<s a="x>y">${"word ".repeat(12)}</s>`;
    for (let limit = 40; limit <= 80; limit++) {
      const chunks = chunkSSML(`<speak>${body}</speak>`, limit);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(limit);
        // A tag torn at the > inside the quotes fails the oracle.
        const parsed = checkXml(chunk);
        if (!parsed.ok) throw new Error(`${parsed.reason} in ${chunk}`);
      }
    }
  });

  it("keeps a comment and a processing instruction whole at any cut", () => {
    const markup = ["<!-- a > comment -->", "<?pi x?>"];
    const body = `one ${markup[0]} two ${markup[1]} three`;
    // Whitespace goes with the chunk it lands in, dropped or not.
    const withoutMarkup = (text: string) =>
      markup.reduce((rest, piece) => rest.replaceAll(piece, ""), text).replace(/\s+/g, " ");
    for (let limit = 36; limit <= 70; limit++) {
      const chunks = chunkSSML(`<speak>${body}</speak>`, limit);
      for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(limit);
      expect(withoutMarkup(joinBodies(chunks))).toBe(withoutMarkup(body));
      // A comment or instruction alone in a chunk is dropped like any
      // tag-only chunk. Torn, never.
      for (const piece of markup) {
        for (const chunk of chunks) {
          expect(chunk.includes(piece.slice(0, 5)), `${piece} torn in ${chunk}`).toBe(
            chunk.includes(piece),
          );
        }
      }
    }
  });

  it("speaks a CDATA section, and drops one holding only whitespace", () => {
    expect(chunkSSML("<speak><![CDATA[x > y]]></speak>")).toEqual([
      "<speak><![CDATA[x > y]]></speak>",
    ]);
    expect(chunkSSML("<speak><![CDATA[  ]]></speak>")).toEqual([]);
    // An empty section is markup, kept in place like a tag.
    expect(chunkSSML("<speak>a<![CDATA[]]>b</speak>")).toEqual(["<speak>a<![CDATA[]]>b</speak>"]);
  });

  it("emits a CDATA section whole when no chunk can hold its delimiters", () => {
    // Body budget 11 against 12 of delimiters: forced progress, never a spin.
    expect(chunkSSML("<speak><![CDATA[x]]></speak>", 26)).toEqual(["<speak><![CDATA[x]]></speak>"]);
  });

  it("reopens the wrappers around a CDATA section that needs a fresh chunk", () => {
    const document = '<speak><prosody rate="slow">abcdefghij<![CDATA[x]]></prosody></speak>';
    const chunks = chunkSSML(document, 60);
    expect(chunks).toHaveLength(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(60);
      expect(chunk).toContain('<prosody rate="slow">');
      expect(chunk).toContain("</prosody>");
    }
  });

  it.each([
    // No trailing space: a whitespace-only last piece is dropped like any.
    ["chars", "word ".repeat(30).trimEnd(), (chunk: string) => chunk.length],
    ["UTF-8 bytes", "\u{1f600}".repeat(60), utf8ByteLength],
  ])(
    "cuts a CDATA section over the limit, re-delimiting every piece (%s)",
    (_m, content, sizeOf) => {
      const section = /^<speak><!\[CDATA\[(.*)\]\]><\/speak>$/su;
      for (let limit = 40; limit <= 80; limit++) {
        const chunks = chunkSSML(`<speak><![CDATA[${content}]]></speak>`, limit, sizeOf);
        expect(chunks.length).toBeGreaterThan(1);
        const pieces = chunks.map((chunk) => {
          expect(sizeOf(chunk), `over the limit: ${chunk}`).toBeLessThanOrEqual(limit);
          const match = section.exec(chunk);
          if (!match) throw new Error(`not one CDATA section: ${chunk}`);
          return match[1] as string;
        });
        expect(pieces.join("")).toBe(content);
      }
    },
  );

  it("budgets the closers it will append in the provider's measure, not in code units", () => {
    // A non-ASCII element name: its closer is longer in bytes than in chars.
    const body = `<é:prosody xmlns:é="http://www.w3.org/2001/10/synthesis">${"abcdefghij".repeat(4)}</é:prosody>`;
    for (let limit = 90; limit <= 110; limit++) {
      const chunks = chunkSSML(`<speak>${body}</speak>`, limit, utf8ByteLength);
      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) expect(utf8ByteLength(chunk)).toBeLessThanOrEqual(limit);
    }
  });

  it("drops the document's own <speak> tag whatever its attributes, and an unmatched closer", () => {
    expect(chunkSSML('<speak xml:lang="en-US">hello <break/> world</speak>')).toEqual([
      "<speak>hello <break/> world</speak>",
    ]);
    expect(chunkSSML("<speak>hello</p></speak>")).toEqual(["<speak>hello</speak>"]);
    expect(chunkSSML("<speak>   </speak>")).toEqual([]);
  });
});
