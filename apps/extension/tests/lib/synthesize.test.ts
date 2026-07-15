import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { getSettings, SettingsSchema, setSettings } from "@/lib/storage";
import { getAudioUri, NoVoiceSelectedError, ProviderDisabledError } from "@/lib/synthesize";
import { polly } from "@/providers/polly";

describe("getAudioUri", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it("throws ProviderDisabledError when the selected provider is disabled", async () => {
    await setSettings(
      SettingsSchema.parse({
        selectedVoice: { providerId: "polly", voiceId: "Joanna" },
        enabledProviders: { polly: false },
      }),
    );
    await expect(
      getAudioUri({ text: "Hi", encoding: "MP3", settings: await getSettings() }),
    ).rejects.toBeInstanceOf(ProviderDisabledError);
  });

  it("throws NoVoiceSelectedError when nothing is selected", async () => {
    await setSettings(SettingsSchema.parse({ selectedVoice: null }));
    await expect(
      getAudioUri({ text: "Hi", encoding: "MP3", settings: await getSettings() }),
    ).rejects.toBeInstanceOf(NoVoiceSelectedError);
  });

  it("dispatches to the selected voice's provider and wraps bytes in a data URI", async () => {
    await setSettings(
      SettingsSchema.parse({
        selectedVoice: { providerId: "polly", voiceId: "Joanna" },
        credentials: { polly: { accessKeyId: "a", secretAccessKey: "s", region: "r" } },
        enabledProviders: { polly: true },
        model: "neural",
        speed: 1.5,
      }),
    );

    const synth = vi.spyOn(polly, "synthesize").mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/mpeg",
      extension: "mp3",
    });

    const uri = await getAudioUri({
      text: "Hello",
      encoding: "MP3",
      speed: 2,
      settings: await getSettings(),
    });

    expect(uri.startsWith("data:audio/mp3;base64,")).toBe(true);
    expect(synth).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello",
        voiceId: "Joanna",
        model: "neural",
        encoding: "MP3",
        speed: 2, // explicit override wins over settings.speed
      }),
    );
  });
});
