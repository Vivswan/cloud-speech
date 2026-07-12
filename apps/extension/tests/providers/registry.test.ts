import { describe, expect, it } from "vitest";
import { getProvider, providerList, providers } from "@/providers";
import { PROVIDER_IDS } from "@/providers/types";

describe("provider registry", () => {
  it("registers every provider id exactly once", () => {
    expect(Object.keys(providers).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(providerList).toHaveLength(PROVIDER_IDS.length);
  });

  it("every provider satisfies the TtsProvider contract", () => {
    for (const provider of providerList) {
      expect(provider.id).toBeTruthy();
      expect(provider.labelKey).toMatch(/^providers\./);
      expect(provider.color).toMatch(/^#/);
      expect(provider.credentialSchema.length).toBeGreaterThan(0);
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.audioFormats.length).toBeGreaterThan(0);
      expect(provider.limits.maxChars).toBeGreaterThan(0);
      expect(provider.limits.concurrency).toBeGreaterThan(0);

      // Every provider must offer at least one download and one read-aloud format.
      expect(provider.audioFormats.some((f) => f.forDownload)).toBe(true);
      expect(provider.audioFormats.some((f) => f.forReadAloud)).toBe(true);

      // Predicates and ranges are callable for every declared model.
      for (const model of provider.models) {
        const ranges = provider.ranges(model.value);
        expect(ranges.speed.min).toBeLessThan(ranges.speed.max);
        expect(typeof provider.supportsSpeed(undefined, model.value)).toBe("boolean");
        expect(typeof provider.supportsPitch(undefined, model.value)).toBe("boolean");
        expect(typeof provider.supportsSSML(undefined, model.value)).toBe("boolean");
      }
    }
  });

  it("supportsSpeed reflects whether synthesize can actually express a rate", () => {
    // Polly: rate rides on SSML prosody, rejected by generative/long-form.
    expect(providers.polly.supportsSpeed(undefined, "standard")).toBe(true);
    expect(providers.polly.supportsSpeed(undefined, "neural")).toBe(true);
    expect(providers.polly.supportsSpeed(undefined, "generative")).toBe(false);
    expect(providers.polly.supportsSpeed(undefined, "long-form")).toBe(false);

    // Azure: every engine takes a prosody rate.
    expect(providers.azure.supportsSpeed(undefined, "neural")).toBe(true);
    expect(providers.azure.supportsSpeed(undefined, "standard")).toBe(true);

    // Google: speakingRate is dropped on the Gemini path.
    expect(providers.google.supportsSpeed(undefined, "gemini")).toBe(false);
    expect(providers.google.supportsSpeed(undefined, "standard")).toBe(true);
    expect(providers.google.supportsSpeed(undefined, "wavenet")).toBe(true);
    expect(providers.google.supportsSpeed(undefined, "neural2")).toBe(true);

    // OpenAI: speed is a first-class request parameter on every model.
    expect(providers.openai.supportsSpeed(undefined, "tts-1")).toBe(true);
    expect(providers.openai.supportsSpeed(undefined, "gpt-4o-mini-tts")).toBe(true);

    // OpenAI-compatible: same request shape; ignoring servers degrade gracefully.
    expect(providers.custom.supportsSpeed(undefined, "tts-1")).toBe(true);
  });

  it("getProvider resolves by id", () => {
    for (const id of PROVIDER_IDS) {
      expect(getProvider(id).id).toBe(id);
    }
  });
});
