import { describe, expect, it } from "vitest";
import { bytesToDataUri, concatBytes, mapWithConcurrency } from "@/lib/tts";

describe("concatBytes", () => {
  it("concatenates chunks in order", () => {
    const result = concatBytes([new Uint8Array([1, 2]), new Uint8Array([]), new Uint8Array([3])]);
    expect([...result]).toEqual([1, 2, 3]);
  });
});

describe("bytesToDataUri", () => {
  it("produces a valid data URI", () => {
    const uri = bytesToDataUri(new Uint8Array([72, 105]), "mp3");
    expect(uri).toBe(`data:audio/mp3;base64,${btoa("Hi")}`);
  });

  it("handles large buffers without a stack overflow", () => {
    // 5 MB: spreading this into String.fromCharCode at once would blow the stack.
    const big = new Uint8Array(5 * 1024 * 1024).fill(65);
    const uri = bytesToDataUri(big, "mp3");
    expect(uri.startsWith("data:audio/mp3;base64,")).toBe(true);
    // Round-trip a sample to confirm integrity.
    const decoded = atob(uri.slice("data:audio/mp3;base64,".length));
    expect(decoded.length).toBe(big.length);
    expect(decoded.charCodeAt(0)).toBe(65);
    expect(decoded.charCodeAt(decoded.length - 1)).toBe(65);
  });
});

describe("mapWithConcurrency", () => {
  it("preserves input order in the results", async () => {
    const results = await mapWithConcurrency([30, 10, 20], 2, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    expect(results).toEqual([30, 10, 20]);
  });

  it("never exceeds the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 2, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
    });
    expect(peak).toBeLessThanOrEqual(2);
  });
});
