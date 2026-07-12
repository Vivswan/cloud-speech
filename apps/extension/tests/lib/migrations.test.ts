import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing";
import {
  buildSettingsFromLegacy,
  looksLikeAwsRegion,
  migrateLegacySettings,
} from "@/lib/migrations";
import { getSettings } from "@/lib/storage";

describe("looksLikeAwsRegion", () => {
  it("recognizes AWS-style regions", () => {
    expect(looksLikeAwsRegion("us-east-1")).toBe(true);
    expect(looksLikeAwsRegion("ap-southeast-2")).toBe(true);
  });

  it("rejects Azure-style regions", () => {
    expect(looksLikeAwsRegion("eastus")).toBe(false);
    expect(looksLikeAwsRegion("westeurope")).toBe(false);
  });
});

describe("buildSettingsFromLegacy", () => {
  it("migrates a legacy Polly fork blob", () => {
    const settings = buildSettingsFromLegacy({
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      region: "us-east-1",
      language: "en-US",
      voices: { "en-US": "Joanna", "de-DE": "Vicki" },
      speed: 1.5,
      engine: "neural",
      credentialsValid: true,
    });

    expect(settings.credentials.polly).toEqual({
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      region: "us-east-1",
    });
    expect(settings.credentials.azure).toBeUndefined();
    expect(settings.credentialsValid.polly).toBe(true);
    expect(settings.enabledProviders.polly).toBe(true);
    // EVERY per-language voice must migrate, tagged with the inferred provider.
    expect(settings.voicesByLanguage).toEqual({
      "en-US": { providerId: "polly", voiceId: "Joanna" },
      "de-DE": { providerId: "polly", voiceId: "Vicki" },
    });
    expect(settings.selectedVoice).toEqual({ providerId: "polly", voiceId: "Joanna" });
    expect(settings.speed).toBe(1.5);
    expect(settings.model).toBe("neural");
  });

  it("migrates a legacy Azure fork blob", () => {
    const settings = buildSettingsFromLegacy({
      subscriptionKey: "azkey",
      region: "eastus",
      language: "en-US",
      voices: { "en-US": "en-US-JennyNeural" },
    });

    expect(settings.credentials.azure).toEqual({ subscriptionKey: "azkey", region: "eastus" });
    expect(settings.credentials.polly).toBeUndefined();
    expect(settings.selectedVoice).toEqual({
      providerId: "azure",
      voiceId: "en-US-JennyNeural",
    });
  });

  it("disambiguates the shared region field when BOTH families exist", () => {
    const awsRegion = buildSettingsFromLegacy({
      accessKeyId: "a",
      secretAccessKey: "s",
      subscriptionKey: "z",
      region: "us-east-1",
    });
    expect(awsRegion.credentials.polly?.region).toBe("us-east-1");
    expect(awsRegion.credentials.azure?.region).toBe("eastus"); // default, not the AWS value

    const azureRegion = buildSettingsFromLegacy({
      accessKeyId: "a",
      secretAccessKey: "s",
      subscriptionKey: "z",
      region: "westeurope",
    });
    expect(azureRegion.credentials.azure?.region).toBe("westeurope");
    expect(azureRegion.credentials.polly?.region).toBe("us-east-1"); // default
  });

  it("applies the OGG download rollback guard", () => {
    const settings = buildSettingsFromLegacy({
      subscriptionKey: "k",
      region: "eastus",
      downloadEncoding: "OGG_OPUS",
    });
    expect(settings.downloadEncoding).toBe("MP3_64_KBPS");
  });
});

describe("migrateLegacySettings", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("is a no-op on a fresh install", async () => {
    expect(await migrateLegacySettings()).toBe(false);
  });

  it("migrates once and is idempotent", async () => {
    await fakeBrowser.storage.sync.set({
      accessKeyId: "AKIA",
      secretAccessKey: "s",
      region: "us-east-1",
      language: "en-US",
      voices: { "en-US": "Joanna" },
    });

    expect(await migrateLegacySettings()).toBe(true);

    const settings = await getSettings();
    expect(settings.credentials.polly?.accessKeyId).toBe("AKIA");

    // Legacy keys removed, new object present — never a clear().
    const raw = await fakeBrowser.storage.sync.get(null);
    expect(raw.accessKeyId).toBeUndefined();
    expect(raw.settings).toBeDefined();

    // Second run: nothing to do, nothing destroyed.
    expect(await migrateLegacySettings()).toBe(false);
    const again = await getSettings();
    expect(again.credentials.polly?.accessKeyId).toBe("AKIA");
  });

  it("preserves unknown keys (non-destructive)", async () => {
    await fakeBrowser.storage.sync.set({
      subscriptionKey: "k",
      region: "eastus",
      someUnknownKey: "keep-me",
    });

    await migrateLegacySettings();

    const raw = await fakeBrowser.storage.sync.get(null);
    expect(raw.someUnknownKey).toBe("keep-me");
  });
});

describe("presence-based provider detection", () => {
  it("keeps voices/settings for users with EMPTY credential keys", () => {
    // The old forks wrote empty-string credential keys at install time.
    const settings = buildSettingsFromLegacy({
      accessKeyId: "",
      secretAccessKey: "",
      region: "us-east-1",
      language: "en-US",
      voices: { "en-US": "Joanna" },
      speed: 1.5,
    });
    expect(settings.selectedVoice).toEqual({ providerId: "polly", voiceId: "Joanna" });
    expect(settings.speed).toBe(1.5);
    expect(settings.enabledProviders.polly).toBe(false); // creds incomplete
  });

  it("rescues the legacy Google Cloud apiKey", () => {
    const settings = buildSettingsFromLegacy({ apiKey: "AIzaLegacy" });
    expect(settings.credentials.google).toEqual({ apiKey: "AIzaLegacy" });
    expect(settings.credentialsValid.google).toBe(false);
  });

  it("coerces string-valued numeric fields instead of throwing", () => {
    const settings = buildSettingsFromLegacy({
      subscriptionKey: "k",
      region: "eastus",
      speed: "1.5" as unknown as number,
      pitch: "abc" as unknown as number,
    });
    expect(settings.speed).toBe(1.5);
    expect(settings.pitch).toBe(0); // unparseable → default
  });
});
