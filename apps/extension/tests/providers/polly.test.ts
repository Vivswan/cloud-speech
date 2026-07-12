import { describe, expect, it } from "vitest";
import { stripSsmlTags } from "@/lib/text";
import { buildSsml, polly } from "@/providers/polly";

describe("polly buildSsml", () => {
  it("returns null for plain text with default prosody", () => {
    expect(buildSsml("Hello", "standard", { speed: 1, pitch: 0, volumeGainDb: 0 })).toBeNull();
  });

  it("uses an ABSOLUTE rate percentage", () => {
    const ssml = buildSsml("Hello", "neural", { speed: 1.5, pitch: 0, volumeGainDb: 0 });
    expect(ssml).toBe('<speak><prosody rate="150%">Hello</prosody></speak>');
  });

  it("includes pitch only for the standard engine", () => {
    const standard = buildSsml("Hi", "standard", { speed: 1, pitch: 5, volumeGainDb: 0 });
    expect(standard).toContain('pitch="+5%"');

    const neural = buildSsml("Hi", "neural", { speed: 1, pitch: 5, volumeGainDb: 0 });
    expect(neural).toBeNull();
  });

  it("skips prosody entirely for generative/long-form engines", () => {
    expect(buildSsml("Hi", "generative", { speed: 2, pitch: 5, volumeGainDb: 8 })).toBeNull();
    expect(buildSsml("Hi", "long-form", { speed: 2, pitch: 5, volumeGainDb: 8 })).toBeNull();
  });

  it("formats negative pitch and volume with explicit signs", () => {
    const ssml = buildSsml("Hi", "standard", { speed: 1, pitch: -3, volumeGainDb: -6 });
    expect(ssml).toContain('pitch="-3%"');
    expect(ssml).toContain('volume="-6dB"');

    const positive = buildSsml("Hi", "standard", { speed: 1, pitch: 3, volumeGainDb: 6 });
    expect(positive).toContain('pitch="+3%"');
    expect(positive).toContain('volume="+6dB"');
  });

  it("returns null for non-SSML engines (request goes out as plain TEXT)", () => {
    const ssml = buildSsml("<speak>Hi</speak>", "generative", {
      speed: 2,
      pitch: 0,
      volumeGainDb: 0,
    });
    expect(ssml).toBeNull();
    // The synthesize path strips markup before sending TEXT:
    expect(stripSsmlTags("<speak>Hi <break/> there</speak>")).toBe("Hi there");
  });

  it("wraps existing SSML content inside the prosody tag", () => {
    const ssml = buildSsml("<speak>Hi <break/> there</speak>", "standard", {
      speed: 2,
      pitch: 0,
      volumeGainDb: -6,
    });
    expect(ssml).toBe(
      '<speak><prosody rate="200%" volume="-6dB">Hi <break/> there</prosody></speak>',
    );
  });
});

describe("polly provider metadata", () => {
  it("requires all three credential fields", () => {
    expect(
      polly.hasCredentials({ accessKeyId: "a", secretAccessKey: "b", region: "us-east-1" }),
    ).toBe(true);
    expect(
      polly.hasCredentials({ accessKeyId: "a", secretAccessKey: "", region: "us-east-1" }),
    ).toBe(false);
    expect(polly.hasCredentials(undefined)).toBe(false);
  });

  it("offers OGG for read-aloud but never for download", () => {
    const ogg = polly.audioFormats.find((f) => f.id === "OGG_OPUS");
    expect(ogg?.forReadAloud).toBe(true);
    expect(ogg?.forDownload).toBe(false);
    expect(ogg?.stitchable).toBe(false);
  });

  it("gates pitch on the standard engine via the predicate", () => {
    expect(polly.supportsPitch(undefined, "standard")).toBe(true);
    expect(polly.supportsPitch(undefined, "neural")).toBe(false);
    expect(polly.supportsPitch(undefined, "generative")).toBe(false);
  });

  it("gates speed on the SSML engines via the predicate", () => {
    // Rate rides on SSML prosody, which only standard/neural accept.
    expect(polly.supportsSpeed(undefined, "standard")).toBe(true);
    expect(polly.supportsSpeed(undefined, "neural")).toBe(true);
    expect(polly.supportsSpeed(undefined, "generative")).toBe(false);
    expect(polly.supportsSpeed(undefined, "long-form")).toBe(false);
  });
});
