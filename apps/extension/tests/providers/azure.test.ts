import { describe, expect, it } from "vitest";
import { azure, buildSsml, localeFromShortName } from "@/providers/azure";
import type { NormalizedVoice } from "@/providers/types";

const FLAT = { speed: 1, pitch: 0, volumeGainDb: 0 };

function envelope(lang: string, voiceId: string, body: string): string {
  return (
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ' +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">` +
    `<voice name="${voiceId}">${body}</voice></speak>`
  );
}

describe("azure buildSsml", () => {
  it.each([
    {
      name: "default prosody: no <prosody> tag, xml:lang derived from the voice shortName",
      text: "Hello",
      voiceId: "en-US-JennyNeural",
      prosody: FLAT,
      expected: envelope("en-US", "en-US-JennyNeural", "Hello"),
    },
    {
      name: "a shortName with no locale falls back to en-US",
      text: "Hi",
      voiceId: "v",
      prosody: FLAT,
      expected: envelope("en-US", "v", "Hi"),
    },
    {
      name: "faster speed is a RELATIVE rate percentage (Polly's is absolute)",
      text: "Hi",
      voiceId: "v",
      prosody: { ...FLAT, speed: 1.5 },
      expected: envelope("en-US", "v", '<prosody rate="+50%">Hi</prosody>'),
    },
    {
      name: "slower speed is a negative relative rate",
      text: "Hi",
      voiceId: "v",
      prosody: { ...FLAT, speed: 0.75 },
      expected: envelope("en-US", "v", '<prosody rate="-25%">Hi</prosody>'),
    },
    {
      name: "negative pitch and volume carry explicit signs and units",
      text: "Hi",
      voiceId: "v",
      prosody: { ...FLAT, pitch: -4, volumeGainDb: -8 },
      expected: envelope("en-US", "v", '<prosody pitch="-4%" volume="-8dB">Hi</prosody>'),
    },
    {
      name: "a style wraps the body in mstts:express-as",
      text: "Hi",
      voiceId: "v",
      prosody: { ...FLAT, style: "cheerful" },
      expected: envelope("en-US", "v", '<mstts:express-as style="cheerful">Hi</mstts:express-as>'),
    },
    {
      name: "incoming SSML is unwrapped so only the Azure <speak> envelope remains",
      text: "<speak>Hi <break/> now</speak>",
      voiceId: "v",
      prosody: { ...FLAT, pitch: 2 },
      expected: envelope("en-US", "v", '<prosody pitch="+2%">Hi <break/> now</prosody>'),
    },
    {
      name: "an explicit language wins over the voice shortName for xml:lang",
      text: "Hi",
      voiceId: "fr-FR-DeniseNeural",
      prosody: { ...FLAT, language: "de-DE" },
      expected: envelope("de-DE", "fr-FR-DeniseNeural", "Hi"),
    },
    {
      name: "xml:lang is derived from a non-English voice shortName",
      text: "Hi",
      voiceId: "fr-FR-DeniseNeural",
      prosody: FLAT,
      expected: envelope("fr-FR", "fr-FR-DeniseNeural", "Hi"),
    },
  ])("$name", ({ text, voiceId, prosody, expected }) => {
    expect(buildSsml(text, voiceId, prosody)).toBe(expected);
  });

  it("localeFromShortName keeps multi-segment locales intact", () => {
    expect(localeFromShortName("fr-FR-DeniseNeural")).toBe("fr-FR");
    expect(localeFromShortName("iu-Cans-CA-SiqiniqNeural")).toBe("iu-Cans-CA");
    expect(localeFromShortName("v")).toBeNull();
  });
});

describe("azure provider metadata", () => {
  it("supports styles only for neural voices that list styles", () => {
    const voiceWithStyles: NormalizedVoice = {
      id: "v",
      providerId: "azure" as const,
      displayName: "V",
      languageCodes: ["en-US"],
      gender: "Female",
      models: ["neural"],
      styles: ["cheerful"],
    };
    expect(azure.supportsStyle(voiceWithStyles, "neural")).toBe(true);
    expect(azure.supportsStyle(voiceWithStyles, "standard")).toBe(false);
    expect(azure.supportsStyle({ ...voiceWithStyles, styles: [] }, "neural")).toBe(false);
  });
});
