import { describe, expect, it } from "vitest";
import { parseVoiceKey, voiceKey } from "@/components/app/VoicePicker";
import type { NormalizedVoice } from "@/providers/types";

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

  it("splits on the FIRST colon only — voice ids may contain colons", () => {
    const parsed = parseVoiceKey("google:projects/x/voices:weird:id");
    expect(parsed).toEqual({ providerId: "google", voiceId: "projects/x/voices:weird:id" });
  });

  it("rejects malformed keys", () => {
    expect(parseVoiceKey("nocolon")).toBeNull();
    expect(parseVoiceKey("polly:")).toBeNull();
  });
});
