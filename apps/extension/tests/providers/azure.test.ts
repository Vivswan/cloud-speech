import { describe, expect, it } from "vitest";
import { azure, buildSsml, localeFromShortName } from "@/providers/azure";

describe("azure buildSsml", () => {
  it("always wraps in a <voice> tag with the shortName", () => {
    const ssml = buildSsml("Hello", "en-US-JennyNeural", { speed: 1, pitch: 0, volumeGainDb: 0 });
    expect(ssml).toContain('<voice name="en-US-JennyNeural">Hello</voice>');
    expect(ssml).toContain("<speak");
  });

  it("uses a RELATIVE rate percentage", () => {
    const faster = buildSsml("Hi", "v", { speed: 1.5, pitch: 0, volumeGainDb: 0 });
    expect(faster).toContain('rate="+50%"');

    const slower = buildSsml("Hi", "v", { speed: 0.75, pitch: 0, volumeGainDb: 0 });
    expect(slower).toContain('rate="-25%"');
  });

  it("adds an mstts:express-as wrapper when a style is set", () => {
    const ssml = buildSsml("Hi", "v", { speed: 1, pitch: 0, volumeGainDb: 0, style: "cheerful" });
    expect(ssml).toContain('<mstts:express-as style="cheerful">');
    expect(ssml).toContain("xmlns:mstts");
  });

  it("formats negative pitch and volume with explicit signs", () => {
    const ssml = buildSsml("Hi", "v", { speed: 1, pitch: -4, volumeGainDb: -8 });
    expect(ssml).toContain('pitch="-4%"');
    expect(ssml).toContain('volume="-8dB"');
  });

  it("omits the prosody tag entirely at default prosody", () => {
    const ssml = buildSsml("Hi", "v", { speed: 1, pitch: 0, volumeGainDb: 0 });
    expect(ssml).not.toContain("<prosody");
    expect(ssml).toContain(">Hi</voice>");
  });

  it("unwraps incoming SSML and re-wraps it in the Azure envelope", () => {
    const ssml = buildSsml("<speak>Hi <break/> now</speak>", "v", {
      speed: 1,
      pitch: 2,
      volumeGainDb: 0,
    });
    expect(ssml).toContain('<prosody pitch="+2%">Hi <break/> now</prosody>');
    // The inner <speak> wrapper must not survive.
    expect(ssml?.match(/<speak/g)).toHaveLength(1);
  });

  it("uses the provided language for xml:lang", () => {
    const ssml = buildSsml("Hi", "fr-FR-DeniseNeural", {
      speed: 1,
      pitch: 0,
      volumeGainDb: 0,
      language: "de-DE",
    });
    expect(ssml).toContain('xml:lang="de-DE"');
  });

  it("derives xml:lang from the voice shortName when no language is given", () => {
    const ssml = buildSsml("Hi", "fr-FR-DeniseNeural", { speed: 1, pitch: 0, volumeGainDb: 0 });
    expect(ssml).toContain('xml:lang="fr-FR"');
  });

  it("falls back to en-US when the shortName has no locale", () => {
    const ssml = buildSsml("Hi", "v", { speed: 1, pitch: 0, volumeGainDb: 0 });
    expect(ssml).toContain('xml:lang="en-US"');
  });

  it("localeFromShortName keeps multi-segment locales intact", () => {
    expect(localeFromShortName("fr-FR-DeniseNeural")).toBe("fr-FR");
    expect(localeFromShortName("iu-Cans-CA-SiqiniqNeural")).toBe("iu-Cans-CA");
    expect(localeFromShortName("v")).toBeNull();
  });
});

describe("azure provider metadata", () => {
  it("requires subscription key and region", () => {
    expect(azure.hasCredentials({ subscriptionKey: "k", region: "eastus" })).toBe(true);
    expect(azure.hasCredentials({ subscriptionKey: "k", region: " " })).toBe(false);
  });

  it("supports styles only for neural voices that list styles", () => {
    const voiceWithStyles = {
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

  it("supports speed on every engine (SSML prosody rate)", () => {
    expect(azure.supportsSpeed(undefined, "neural")).toBe(true);
    expect(azure.supportsSpeed(undefined, "standard")).toBe(true);
  });
});
