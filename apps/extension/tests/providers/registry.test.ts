import { describe, expect, it } from "vitest";
import { getProvider, providerList, providers } from "@/providers";
import { PROVIDER_IDS, type ProviderId, type TtsProvider } from "@/providers/types";

describe("provider registry", () => {
  it("registers every provider id exactly once", () => {
    expect(Object.keys(providers).sort()).toEqual([...PROVIDER_IDS].sort());
    expect(providerList).toHaveLength(PROVIDER_IDS.length);
  });

  it("every provider offers a download and a read-aloud format and a usable speed range", () => {
    for (const provider of providerList) {
      expect(provider.color).toMatch(/^#/);
      expect(provider.credentialSchema.length).toBeGreaterThan(0);
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.limits.maxChars).toBeGreaterThan(0);
      expect(provider.limits.concurrency).toBeGreaterThan(0);

      expect(provider.audioFormats.some((f) => f.forDownload)).toBe(true);
      expect(provider.audioFormats.some((f) => f.forReadAloud)).toBe(true);

      for (const model of provider.models) {
        const ranges = provider.ranges(model.value);
        expect(ranges.speed.min).toBeLessThan(ranges.speed.max);
      }
    }
  });

  it("getProvider resolves by id", () => {
    for (const id of PROVIDER_IDS) {
      expect(getProvider(id).id).toBe(id);
    }
  });
});

interface Capabilities {
  speed: boolean;
  pitch: boolean;
  volume: boolean;
  style: boolean;
  ssml: boolean;
}

function capabilities(provider: TtsProvider, model: string): Capabilities {
  return {
    speed: provider.supportsSpeed(undefined, model),
    pitch: provider.supportsPitch(undefined, model),
    volume: provider.supportsVolume(undefined, model),
    style: provider.supportsStyle(undefined, model),
    ssml: provider.supportsSSML(undefined, model),
  };
}

const SPEED_ONLY: Capabilities = {
  speed: true,
  pitch: false,
  volume: false,
  style: false,
  ssml: false,
};
const NOTHING: Capabilities = {
  speed: false,
  pitch: false,
  volume: false,
  style: false,
  ssml: false,
};
const SSML_PROSODY: Capabilities = {
  speed: true,
  pitch: true,
  volume: true,
  style: false,
  ssml: true,
};

// What each engine can express on the wire, asked without a voice. Voice-level refinements
// (Azure styles, Google Chirp and Gemini voice names) have their own tests in azure.test.ts and
// rest-providers.test.ts.
const CAPABILITIES: [ProviderId, string, Capabilities][] = [
  // Polly: rate, pitch, and volume ride on SSML prosody, which generative/long-form reject;
  // pitch is a standard-engine-only attribute.
  ["polly", "standard", SSML_PROSODY],
  ["polly", "neural", { ...SSML_PROSODY, pitch: false }],
  ["polly", "generative", NOTHING],
  ["polly", "long-form", NOTHING],
  // Azure: every engine takes a prosody rate, pitch, and volume.
  ["azure", "neural", SSML_PROSODY],
  ["azure", "standard", SSML_PROSODY],
  // Google: speakingRate is dropped on the Gemini path; Chirp families take no pitch or SSML.
  ["google", "standard", SSML_PROSODY],
  ["google", "wavenet", SSML_PROSODY],
  ["google", "neural2", SSML_PROSODY],
  ["google", "chirp", { ...SPEED_ONLY, volume: true }],
  ["google", "chirp3", { ...SPEED_ONLY, volume: true }],
  ["google", "gemini", NOTHING],
  // OpenAI: speed is a first-class request parameter on every model, nothing else is.
  ["openai", "gpt-4o-mini-tts", SPEED_ONLY],
  ["openai", "tts-1", SPEED_ONLY],
  ["openai", "tts-1-hd", SPEED_ONLY],
  // OpenAI-compatible: same request shape; servers that ignore speed degrade gracefully.
  ["custom", "tts-1", SPEED_ONLY],
];

describe("capability predicates", () => {
  it.each(CAPABILITIES)(
    "%s %s exposes only what its synthesize path sends",
    (id, model, expected) => {
      expect(capabilities(providers[id], model)).toEqual(expected);
    },
  );

  it("the table covers exactly the roster's models", () => {
    const roster = providerList.flatMap((p) => p.models.map((m) => `${p.id}:${m.value}`));
    const table = CAPABILITIES.map(([id, model]) => `${id}:${model}`);
    expect(table.sort()).toEqual(roster.sort());
  });
});
