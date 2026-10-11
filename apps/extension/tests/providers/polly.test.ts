import { describe, expect, it } from "vitest";
import { stripSsmlTags } from "@/lib/text/text";
import { buildSsml } from "@/providers/polly";

describe("polly buildSsml", () => {
  // Polly's prosody dialect: rate is an absolute percentage, pitch is a signed percentage that only the
  // standard engine accepts, volume is a signed dB figure, and the generative and long-form engines take
  // no SSML at all. Default prosody sends plain text (null).
  it.each([
    { engine: "standard", speed: 1, pitch: 0, volumeGainDb: 0, ssml: null },
    {
      engine: "neural",
      speed: 1.5,
      pitch: 0,
      volumeGainDb: 0,
      ssml: '<speak><prosody rate="150%">Hello</prosody></speak>',
    },
    {
      engine: "standard",
      speed: 1,
      pitch: 5,
      volumeGainDb: 0,
      ssml: '<speak><prosody pitch="+5%">Hello</prosody></speak>',
    },
    { engine: "neural", speed: 1, pitch: 5, volumeGainDb: 0, ssml: null },
    { engine: "generative", speed: 2, pitch: 5, volumeGainDb: 8, ssml: null },
    { engine: "long-form", speed: 2, pitch: 5, volumeGainDb: 8, ssml: null },
    {
      engine: "standard",
      speed: 1,
      pitch: -3,
      volumeGainDb: -6,
      ssml: '<speak><prosody pitch="-3%" volume="-6dB">Hello</prosody></speak>',
    },
    {
      engine: "standard",
      speed: 1,
      pitch: 3,
      volumeGainDb: 6,
      ssml: '<speak><prosody pitch="+3%" volume="+6dB">Hello</prosody></speak>',
    },
  ])(
    "$engine engine, speed $speed, pitch $pitch, volume $volumeGainDb dB -> $ssml",
    ({ engine, speed, pitch, volumeGainDb, ssml }) => {
      expect(buildSsml("Hello", engine, { speed, pitch, volumeGainDb })).toBe(ssml);
    },
  );

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
