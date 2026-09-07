import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { credentialsDigest, textDigest } from "@/lib/digest";

const SRC = resolve(__dirname, "../../src");

describe("credentialsDigest", () => {
  const server = (baseUrl: string) => ({
    baseUrl,
    apiKey: "sk-secret-key",
    model: "kokoro",
    voices: "af_heart",
  });

  it("gives distinct credential sets distinct digests, including a pair the 32-bit textDigest maps together", async () => {
    // Regression pair: these two collided under textDigest (both "12728pq:107"),
    // so a read on the second server replayed the first server's audio.
    const a = server("https://001r.example/v1");
    const b = server("https://0030.example/v1");
    const sortedFields = (c: Record<string, string>) =>
      JSON.stringify(Object.entries(c).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
    expect(textDigest(sortedFields(a))).toBe("12728pq:107");
    expect(textDigest(sortedFields(b))).toBe("12728pq:107");
    expect(await credentialsDigest(a)).not.toBe(await credentialsDigest(b));
    expect(await credentialsDigest(a)).not.toBe(
      await credentialsDigest(server("https://0031.example/v1")),
    );
  });

  it("ignores field order", async () => {
    const ordered = { apiKey: "k", baseUrl: "https://a.example", region: "eu" };
    const shuffled = { region: "eu", baseUrl: "https://a.example", apiKey: "k" };
    expect(await credentialsDigest(shuffled)).toBe(await credentialsDigest(ordered));
  });

  it("does not merge fields whose values contain separators", async () => {
    expect(await credentialsDigest({ a: "1,b:2" })).not.toBe(
      await credentialsDigest({ a: "1", b: "2" }),
    );
  });

  it("is the full SHA-256 in hex of the sorted fields, so it carries no credential value and is stable across contexts", async () => {
    // sha256 of [["apiKey","sk-secret-key"],["baseUrl","https://a.example/v1"],["model","kokoro"],["voices","af_heart"]]
    // computed independently with node:crypto; a truncated or padded digest fails here.
    expect(await credentialsDigest(server("https://a.example/v1"))).toBe(
      "051a2edcd2db8523b5020685793d33ae25ad18ddbad12f259fe5678398e5a867",
    );
  });
});

describe("textDigest call sites", () => {
  it("hash only the read's text, at the popup-matching sites", () => {
    // Credentials and settings key caches and dedupe registries through
    // credentialsDigest: at 32 bits two of them do collide (see above), and a
    // collision there replays or skips work. A new `textDigest(` in the
    // source lands here until it is listed as a text-only site.
    const calls = readdirSync(SRC, { recursive: true, encoding: "utf8" })
      .filter((path) => /\.tsx?$/.test(path))
      .flatMap((path) =>
        readFileSync(resolve(SRC, path), "utf8")
          .split("\n")
          .filter((line) => /(?<!function )\btextDigest\(/.test(line))
          .map((line) => `${path}: ${line.trim()}`),
      );
    expect(calls.sort()).toEqual([
      "components/app/views/Sandbox.tsx: playback.textDigest !== textDigest(value)",
      "lib/transport.ts: textDigest: textDigest(text),",
    ]);
  });
});
