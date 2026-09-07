import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseVoiceKey, voiceKey } from "@/lib/voice-key";
import { type NormalizedVoice, PROVIDER_IDS } from "@/providers/types";

const voice: NormalizedVoice = {
  id: "en-US-JennyNeural",
  providerId: "azure",
  displayName: "Jenny",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
};

describe("voice composite keys", () => {
  it("round-trips provider and voice id", () => {
    const key = voiceKey(voice);
    expect(key).toBe("azure:en-US-JennyNeural");
    expect(parseVoiceKey(key)).toEqual({ providerId: "azure", voiceId: "en-US-JennyNeural" });
  });

  it("parseVoiceKey inverts voiceKey for every provider and any non-empty voice id", () => {
    // Ids with colons (Google project-scoped ids) are generated on purpose,
    // not left to chance.
    const voiceId = fc.oneof(
      fc.string({ unit: "grapheme", minLength: 1 }),
      fc.tuple(fc.string(), fc.string()).map(([head, tail]) => `${head}:${tail}`),
    );
    fc.assert(
      fc.property(fc.constantFrom(...PROVIDER_IDS), voiceId, (providerId, id) => {
        expect(parseVoiceKey(voiceKey({ ...voice, providerId, id }))).toEqual({
          providerId,
          voiceId: id,
        });
      }),
    );
  });

  it("splits on the FIRST colon only, since voice ids may contain colons", () => {
    const parsed = parseVoiceKey("google:projects/x/voices:weird:id");
    expect(parsed).toEqual({ providerId: "google", voiceId: "projects/x/voices:weird:id" });
  });

  it("rejects malformed keys", () => {
    expect(parseVoiceKey("nocolon")).toBeNull();
    expect(parseVoiceKey("polly:")).toBeNull();
  });

  it("rejects unknown provider prefixes (e.g. a stale favorite)", () => {
    expect(parseVoiceKey("bogus:some-voice")).toBeNull();
    expect(parseVoiceKey(":some-voice")).toBeNull();
  });
});
