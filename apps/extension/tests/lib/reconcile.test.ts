import { describe, expect, it } from "vitest";
import { reconcile } from "@/lib/reconcile";
import { DEFAULT_SETTINGS, type Settings } from "@/lib/storage";
import type { NormalizedVoice } from "@/providers/types";

const joanna: NormalizedVoice = {
  id: "Joanna",
  providerId: "polly",
  displayName: "Joanna",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["standard", "neural"],
};

const jenny: NormalizedVoice = {
  id: "en-US-JennyNeural",
  providerId: "azure",
  displayName: "Jenny",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
  styles: ["cheerful"],
};

function settingsWith(patch: Partial<Settings>): Settings {
  return {
    ...DEFAULT_SETTINGS,
    enabledProviders: { polly: true, azure: true },
    ...patch,
  };
}

describe("reconcile", () => {
  it("leaves everything untouched when the voice cache is empty", () => {
    const settings = settingsWith({
      selectedVoice: { providerId: "polly", voiceId: "Ghost" },
    });
    // A transient fetch failure must never wipe a working setup.
    expect(reconcile(settings, [])).toEqual(settings);
  });

  it("keeps a valid selection as-is", () => {
    const settings = settingsWith({
      selectedVoice: { providerId: "polly", voiceId: "Joanna" },
      model: "neural",
    });
    const result = reconcile(settings, [joanna, jenny]);
    expect(result.selectedVoice).toEqual({ providerId: "polly", voiceId: "Joanna" });
    expect(result.model).toBe("neural");
  });

  it("repairs a selection that no longer exists", () => {
    const settings = settingsWith({
      selectedVoice: { providerId: "polly", voiceId: "Deleted" },
      language: "en-US",
    });
    const result = reconcile(settings, [joanna, jenny]);
    expect(result.selectedVoice).toEqual({ providerId: "polly", voiceId: "Joanna" });
  });

  it("prefers a favorite when repairing (first-colon composite key)", () => {
    const settings = settingsWith({
      selectedVoice: null,
      favorites: ["azure:en-US-JennyNeural"],
    });
    const result = reconcile(settings, [joanna, jenny]);
    expect(result.selectedVoice).toEqual({
      providerId: "azure",
      voiceId: "en-US-JennyNeural",
    });
  });

  it("never picks a voice from a disabled provider", () => {
    const settings = settingsWith({
      selectedVoice: { providerId: "azure", voiceId: "en-US-JennyNeural" },
      enabledProviders: { polly: true, azure: false },
    });
    const result = reconcile(settings, [joanna, jenny]);
    expect(result.selectedVoice?.providerId).toBe("polly");
  });

  it("repairs an unsupported model to one the voice supports", () => {
    const settings = settingsWith({
      selectedVoice: { providerId: "azure", voiceId: "en-US-JennyNeural" },
      model: "generative", // Polly-only concept
    });
    const result = reconcile(settings, [joanna, jenny]);
    expect(result.model).toBe("neural");
  });

  it("drops a style the voice/model combination does not support", () => {
    const settings = settingsWith({
      selectedVoice: { providerId: "polly", voiceId: "Joanna" },
      model: "neural",
      style: "cheerful", // Polly has no styles
    });
    const result = reconcile(settings, [joanna, jenny]);
    expect(result.style).toBeUndefined();
  });

  it("repairs an OGG download encoding (not offered for download)", () => {
    const settings = settingsWith({
      selectedVoice: { providerId: "polly", voiceId: "Joanna" },
      downloadEncoding: "OGG_OPUS",
    });
    const result = reconcile(settings, [joanna]);
    expect(result.downloadEncoding).toBe("MP3_64_KBPS");
  });

  it("clamps prosody into the provider ranges", () => {
    const settings = settingsWith({
      selectedVoice: { providerId: "polly", voiceId: "Joanna" },
      speed: 99,
      pitch: -99,
      volumeGainDb: 99,
    });
    const result = reconcile(settings, [joanna]);
    // Polly caps prosody rate at 200% — its range tops out at 2, not the default 3.
    expect(result.speed).toBe(2);
    expect(result.pitch).toBe(-10);
    expect(result.volumeGainDb).toBe(16);
  });
});
