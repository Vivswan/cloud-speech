import { describe, it, expect } from "vitest";
import { fileExtMap } from "@/helpers/file-helpers";

describe("fileExtMap", () => {
	it("should map MP3 to mp3 extension", () => {
		expect(fileExtMap.MP3).toBe("mp3");
	});

	it("should map MP3_64_KBPS to mp3 extension", () => {
		expect(fileExtMap.MP3_64_KBPS).toBe("mp3");
	});

	it("should map OGG_OPUS to ogg extension", () => {
		expect(fileExtMap.OGG_OPUS).toBe("ogg");
	});

	it("should have all expected keys", () => {
		const expectedKeys = ["MP3", "MP3_64_KBPS", "OGG_OPUS"];
		const actualKeys = Object.keys(fileExtMap);
		expect(actualKeys).toEqual(expect.arrayContaining(expectedKeys));
	});
});
