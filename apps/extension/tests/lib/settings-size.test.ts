import { describe, expect, it } from "vitest";
import {
  estimateSyncSizeBytes,
  type Settings,
  SettingsSchema,
  SYNC_QUOTA_BYTES_PER_ITEM,
} from "@/lib/storage";

// Tripwire, not a target: the settings object is ONE sync item and must stay well inside Chrome's per-item quota.
// If this trips, look at what grew; favorites stay `providerId:voiceId` strings, never compressed keys.

const AZURE_VOICES = Array.from(
  { length: 40 },
  (_, i) => `azure:en-US-${["Jenny", "Guy", "Aria", "Davis"][i % 4]}Multilingual${i}Neural`,
);

const heavy: Settings = SettingsSchema.parse({
  perProvider: {
    polly: {
      credentials: {
        accessKeyId: "AKIAIOSFODNN7EXAMPLE",
        secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
        region: "ap-southeast-2",
      },
      verified: true,
      enabled: true,
      readAloudEncoding: "OGG_OPUS",
      downloadEncoding: "MP3_64_KBPS",
      lastModel: "generative",
    },
    azure: {
      credentials: { subscriptionKey: "EXAMPLEKEY".repeat(3).slice(0, 32), region: "westeurope" },
      verified: true,
      enabled: true,
      readAloudEncoding: "OGG_OPUS",
      downloadEncoding: "MP3_64_KBPS",
      lastModel: "neural",
    },
    google: {
      credentials: { apiKey: "AIzaSyD-EXAMPLE-EXAMPLE-EXAMPLE-EXAMPLE1" },
      verified: true,
      enabled: true,
      readAloudEncoding: "OGG_OPUS",
      downloadEncoding: "MP3",
      lastModel: "neural2",
    },
    openai: {
      credentials: { apiKey: `sk-proj-${"x".repeat(156)}` },
      verified: true,
      enabled: true,
      readAloudEncoding: "OGG_OPUS",
      downloadEncoding: "MP3",
      lastModel: "gpt-4o-mini-tts",
    },
    custom: {
      credentials: {
        baseUrl: "https://tts.example.internal:8443/v1",
        apiKey: "local-server-key-0123456789",
        voices: "alloy, echo, fable, onyx, nova, shimmer",
      },
      verified: true,
      enabled: true,
      readAloudEncoding: "MP3",
      downloadEncoding: "MP3",
      lastModel: "tts-1-hd",
    },
  },
  selection: {
    providerId: "azure",
    voiceId: "en-US-JennyMultilingualNeural",
    model: "neural",
    style: "cheerful",
  },
  voicesByLanguage: Object.fromEntries(
    [
      "en-US",
      "en-GB",
      "de-DE",
      "fr-FR",
      "es-ES",
      "it-IT",
      "pt-BR",
      "hi-IN",
      "zh-CN",
      "zh-TW",
      "ja-JP",
      "ko-KR",
    ].map((language) => [
      language,
      { providerId: "azure", voiceId: `${language}-SomeoneMultilingualNeural` },
    ]),
  ),
  favorites: AZURE_VOICES,
  speed: 1.25,
  pitch: -2,
  volumeGainDb: 3,
  language: "zh-TW",
  theme: "dark",
  uiLanguage: "zh_TW",
});

describe("sync item size", () => {
  it("a heavy realistic configuration stays under 75% of the per-item quota", () => {
    const estimate = estimateSyncSizeBytes(heavy);
    expect(Object.keys(heavy.perProvider)).toHaveLength(5);
    expect(Object.keys(heavy.voicesByLanguage)).toHaveLength(12);
    expect(heavy.favorites).toHaveLength(40);
    expect(estimate).toBeLessThanOrEqual(SYNC_QUOTA_BYTES_PER_ITEM * 0.75);
  });
});
