import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { NEVER_ABORTS } from "@/lib/slot";
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
        selection: { providerId: "polly", voiceId: "Joanna", model: "neural" },
        perProvider: { polly: { credentials: {}, enabled: false } },
      }),
    );
    await expect(
      getAudioUri({
        text: "Hi",
        purpose: "readAloud",
        settings: await getSettings(),
        signal: NEVER_ABORTS,
      }),
    ).rejects.toBeInstanceOf(ProviderDisabledError);
  });

  it("throws NoVoiceSelectedError when nothing is selected", async () => {
    await setSettings(SettingsSchema.parse({ selection: null }));
    await expect(
      getAudioUri({
        text: "Hi",
        purpose: "readAloud",
        settings: await getSettings(),
        signal: NEVER_ABORTS,
      }),
    ).rejects.toBeInstanceOf(NoVoiceSelectedError);
  });

  it("dispatches to the selected voice's provider with its format for the purpose, forwarding the caller's signal", async () => {
    await setSettings(
      SettingsSchema.parse({
        selection: { providerId: "polly", voiceId: "Joanna", model: "neural", style: "calm" },
        perProvider: {
          polly: {
            credentials: { accessKeyId: "a", secretAccessKey: "s", region: "r" },
            enabled: true,
            downloadEncoding: "MP3",
          },
        },
        speed: 1.5,
      }),
    );

    const synth = vi.spyOn(polly, "synthesize").mockResolvedValue({
      bytes: new Uint8Array([1, 2, 3]),
      mimeType: "audio/mpeg",
      extension: "mp3",
    });

    const signal = new AbortController().signal;
    const uri = await getAudioUri({
      text: "Hello",
      purpose: "download",
      speed: 2,
      settings: await getSettings(),
      signal,
    });

    expect(uri.startsWith("data:audio/mp3;base64,")).toBe(true);
    expect(synth).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Hello",
        voiceId: "Joanna",
        model: "neural",
        style: "calm",
        encoding: "MP3",
        speed: 2, // explicit override wins over settings.speed
        credentials: { accessKeyId: "a", secretAccessKey: "s", region: "r" },
        signal,
      }),
    );
    // The very same signal object: aborting the read must reach the provider.
    expect(synth.mock.calls[0]?.[0].signal).toBe(signal);
  });
});
