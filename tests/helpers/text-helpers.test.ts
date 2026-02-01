import { describe, it, expect, beforeAll } from "vitest";
import { sanitizeTextForSSML } from "@/helpers/text-helpers";

// Import to register String prototype extensions
beforeAll(async () => {
	await import("@/helpers/text-helpers");
});

describe("sanitizeTextForSSML", () => {
	it("should return empty string for empty input", () => {
		expect(sanitizeTextForSSML("")).toBe("");
	});

	it("should return SSML text unchanged", () => {
		const ssml = "<speak>Hello world</speak>";
		expect(sanitizeTextForSSML(ssml)).toBe(ssml);
	});

	it("should strip HTML tags from text", () => {
		const html = "<div>Hello <b>world</b></div>";
		const result = sanitizeTextForSSML(html);
		expect(result).not.toContain("<div>");
		expect(result).not.toContain("<b>");
		expect(result).toContain("Hello");
		expect(result).toContain("world");
	});

	it("should escape XML special characters", () => {
		const text = "Test & < > \" ' characters";
		const result = sanitizeTextForSSML(text);
		expect(result).toContain("&#x26;"); // &
		expect(result).toContain("&#x3C;"); // <
		expect(result).toContain("&#x3E;"); // >
		expect(result).toContain("&#x22;"); // "
		expect(result).toContain("&#x27;"); // '
	});

	it("should decode HTML entities before escaping", () => {
		const text = "&amp; &lt; &gt;";
		const result = sanitizeTextForSSML(text);
		// Should decode entities first, then re-escape for XML
		expect(result).toContain("&#x26;"); // & from &amp;
		expect(result).toContain("&#x3C;"); // < from &lt;
		expect(result).toContain("&#x3E;"); // > from &gt;
	});

	it("should normalize whitespace", () => {
		const text = "Hello    world\n\n\nfoo   bar";
		const result = sanitizeTextForSSML(text);
		expect(result).not.toMatch(/\s{2,}/);
	});

	it("should trim leading and trailing whitespace", () => {
		const text = "   Hello world   ";
		const result = sanitizeTextForSSML(text);
		expect(result).toBe("Hello world");
	});
});

describe("String.prototype.isSSML", () => {
	it("should return true for valid SSML", () => {
		const ssml = "<speak>Hello world</speak>";
		expect(ssml.isSSML()).toBe(true);
	});

	it("should return false for non-SSML text", () => {
		const text = "Hello world";
		expect(text.isSSML()).toBe(false);
	});

	it("should return false for HTML", () => {
		const html = "<div>Hello world</div>";
		expect(html.isSSML()).toBe(false);
	});

	it("should handle SSML with whitespace", () => {
		const ssml = "  <speak>Hello world</speak>  ";
		expect(ssml.isSSML()).toBe(true);
	});
});

describe("String.prototype.chunk", () => {
	it("should chunk plain text into sentences", () => {
		const text = "Hello world. This is a test.";
		const chunks = text.chunk();
		expect(chunks).toBeInstanceOf(Array);
		expect(chunks.length).toBeGreaterThan(0);
	});

	it("should handle single sentence", () => {
		const text = "Hello world.";
		const chunks = text.chunk();
		expect(chunks).toHaveLength(1);
	});

	it("should use chunkSSML for SSML text", () => {
		const ssml = "<speak>Hello world.</speak>";
		const chunks = ssml.chunk();
		expect(chunks).toBeInstanceOf(Array);
		expect(chunks.length).toBeGreaterThan(0);
		chunks.forEach((chunk) => {
			expect(chunk).toContain("<speak>");
			expect(chunk).toContain("</speak>");
		});
	});
});

describe("String.prototype.chunkSSML", () => {
	it("should chunk SSML text", () => {
		const ssml = "<speak>Hello world.</speak>";
		const chunks = ssml.chunkSSML();
		expect(chunks).toBeInstanceOf(Array);
		expect(chunks.length).toBeGreaterThan(0);
	});

	it("should wrap chunks in speak tags", () => {
		const ssml = "<speak>Hello world.</speak>";
		const chunks = ssml.chunkSSML();
		chunks.forEach((chunk) => {
			expect(chunk.startsWith("<speak>")).toBe(true);
			expect(chunk.endsWith("</speak>")).toBe(true);
		});
	});

	it("should handle SSML with prosody tags", () => {
		const ssml = '<speak><prosody rate="medium">Hello world.</prosody></speak>';
		const chunks = ssml.chunkSSML();
		expect(chunks).toBeInstanceOf(Array);
		chunks.forEach((chunk) => {
			expect(chunk).toContain("<speak>");
			expect(chunk).toContain("</speak>");
		});
	});

	it("should split long SSML into multiple chunks", () => {
		// Create a very long SSML text (longer than maxChunkSize)
		const longText = "A".repeat(6000);
		const ssml = `<speak>${longText}</speak>`;
		const chunks = ssml.chunkSSML();

		// Should create multiple chunks
		expect(chunks.length).toBeGreaterThan(1);

		// Each chunk should be a valid SSML document
		chunks.forEach((chunk) => {
			expect(chunk.startsWith("<speak>")).toBe(true);
			expect(chunk.endsWith("</speak>")).toBe(true);
		});
	});
});
