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
    // Each emoji is 2 UTF-16 units but 4 UTF-8 bytes — no spaces, forces hard cuts.
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
    // the wrapper budget — the old code let room go negative, cleared the
    // stack, and then appended the (now unmatched) closing tag.
    const inner = `<prosody rate="150%" pitch="+2%" volume="+3dB">${"x".repeat(500)}</prosody>`;
    const body = `${"pad ".repeat(20)}${inner}`.repeat(6);
    for (const max of [120, 150, 200, 260]) {
      const chunks = chunkSSML(`<speak>${body}</speak>`, max);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(max);
        // Every tag balanced — no orphan closers, no unclosed openers.
        const opens = (chunk.match(/<prosody/g) ?? []).length;
        const closes = (chunk.match(/<\/prosody>/g) ?? []).length;
        expect(closes).toBe(opens);
      }
    }
  });
});
