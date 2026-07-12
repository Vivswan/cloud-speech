import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { SettingsSchema, setSettings, voicesSessionItem } from "@/lib/storage";
import { fetchAllVoices } from "@/lib/voices";
import { azure } from "@/providers/azure";
import { polly } from "@/providers/polly";
import type { NormalizedVoice } from "@/providers/types";

const joanna: NormalizedVoice = {
  id: "Joanna",
  providerId: "polly",
  displayName: "Joanna",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
};

const jenny: NormalizedVoice = {
  id: "en-US-JennyNeural",
  providerId: "azure",
  displayName: "Jenny",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
};

function bothProvidersConfigured() {
  return SettingsSchema.parse({
    credentials: {
      polly: { accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" },
      azure: { subscriptionKey: "k", region: "eastus" },
    },
    enabledProviders: { polly: true, azure: true },
  });
}

describe("fetchAllVoices", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it("merges voices from every enabled provider", async () => {
    await setSettings(bothProvidersConfigured());
    vi.spyOn(polly, "fetchVoices").mockResolvedValue([joanna]);
    vi.spyOn(azure, "fetchVoices").mockResolvedValue([jenny]);

    const voices = await fetchAllVoices();
    expect(voices).toHaveLength(2);
    expect(await voicesSessionItem.getValue()).toHaveLength(2);
  });

  it("isolates failures: one provider throwing never drops the others", async () => {
    await setSettings(bothProvidersConfigured());
    vi.spyOn(polly, "fetchVoices").mockRejectedValue(new Error("throttled"));
    vi.spyOn(azure, "fetchVoices").mockResolvedValue([jenny]);

    const voices = await fetchAllVoices();
    expect(voices).toEqual([jenny]);
  });

  it("keeps last-good cached voices for a transiently failing provider", async () => {
    await setSettings(bothProvidersConfigured());
    await voicesSessionItem.setValue([joanna]);
    vi.spyOn(polly, "fetchVoices").mockRejectedValue(new Error("network"));
    vi.spyOn(azure, "fetchVoices").mockResolvedValue([jenny]);

    const voices = await fetchAllVoices();
    // Polly's cached Joanna survives the failed refresh.
    expect(voices).toContainEqual(joanna);
    expect(voices).toContainEqual(jenny);
  });

  it("skips disabled and un-credentialed providers", async () => {
    await setSettings(
      SettingsSchema.parse({
        credentials: { polly: { accessKeyId: "a", secretAccessKey: "s", region: "r" } },
        enabledProviders: { polly: false },
      }),
    );
    const pollySpy = vi.spyOn(polly, "fetchVoices");

    const voices = await fetchAllVoices();
    expect(voices).toEqual([]);
    expect(pollySpy).not.toHaveBeenCalled();
  });
});
