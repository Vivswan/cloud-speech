import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { getSettings, SETTINGS_VERSION, syncEnabledItem } from "@/lib/storage";
import { runStartupMigrations } from "@/migrations";
import { fromFlatKeys, looksLikeAwsRegion, settingsFromFlatKeys } from "@/migrations/000000";

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

describe("settingsFromFlatKeys", () => {
  it("converts a Polly fork snapshot", () => {
    const settings = settingsFromFlatKeys({
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
    // EVERY per-language voice must carry over, tagged with the inferred provider.
    expect(settings.voicesByLanguage).toEqual({
      "en-US": { providerId: "polly", voiceId: "Joanna" },
      "de-DE": { providerId: "polly", voiceId: "Vicki" },
    });
    expect(settings.selectedVoice).toEqual({ providerId: "polly", voiceId: "Joanna" });
    expect(settings.speed).toBe(1.5);
    expect(settings.model).toBe("neural");
  });

  it("converts an Azure fork snapshot", () => {
    const settings = settingsFromFlatKeys({
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
    const awsRegion = settingsFromFlatKeys({
      accessKeyId: "a",
      secretAccessKey: "s",
      subscriptionKey: "z",
      region: "us-east-1",
    });
    expect(awsRegion.credentials.polly?.region).toBe("us-east-1");
    expect(awsRegion.credentials.azure?.region).toBe("eastus"); // default, not the AWS value

    const azureRegion = settingsFromFlatKeys({
      accessKeyId: "a",
      secretAccessKey: "s",
      subscriptionKey: "z",
      region: "westeurope",
    });
    expect(azureRegion.credentials.azure?.region).toBe("westeurope");
    expect(azureRegion.credentials.polly?.region).toBe("us-east-1"); // default
  });

  it("applies the OGG download rollback guard", () => {
    const settings = settingsFromFlatKeys({
      subscriptionKey: "k",
      region: "eastus",
      downloadEncoding: "OGG_OPUS",
    });
    expect(settings.downloadEncoding).toBe("MP3_64_KBPS");
  });

  it("shapes converted credential records from the frozen v1 field lists", () => {
    // Empty-string region: presence-detected, falls back to defaults.
    const settings = settingsFromFlatKeys({
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      subscriptionKey: "azkey",
      apiKey: "AIzaLegacy",
      region: "",
    });

    // Literal golden records: the v1 output is history and must never move.
    expect(settings.credentials.polly).toEqual({
      accessKeyId: "AKIA123",
      secretAccessKey: "secret",
      region: "us-east-1",
    });
    expect(settings.credentials.azure).toEqual({
      subscriptionKey: "azkey",
      region: "eastus",
    });
    expect(settings.credentials.google).toEqual({ apiKey: "AIzaLegacy" });
  });
});

describe("runStartupMigrations (step 0)", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("is a no-op on a fresh install", async () => {
    await runStartupMigrations();
    expect(await fakeBrowser.storage.sync.get(null)).toEqual({});
  });

  it("migrates once and is idempotent", async () => {
    await fakeBrowser.storage.sync.set({
      accessKeyId: "AKIA",
      secretAccessKey: "s",
      region: "us-east-1",
      language: "en-US",
      voices: { "en-US": "Joanna" },
    });

    await runStartupMigrations();

    // Read through the whole chain: the fork keys land as the current shape.
    const settings = await getSettings();
    expect(settings.perProvider.polly?.credentials.accessKeyId).toBe("AKIA");
    expect(settings.selection).toEqual({ providerId: "polly", voiceId: "Joanna", model: "neural" });
    expect(settings.schemaVersion).toBe(SETTINGS_VERSION);

    // Flat keys removed, new object present, and never a clear().
    const raw = await fakeBrowser.storage.sync.get(null);
    expect(raw.accessKeyId).toBeUndefined();
    expect(raw.settings).toMatchObject({ schemaVersion: SETTINGS_VERSION });

    // Second run: nothing to do, nothing destroyed.
    const setSpy = vi.spyOn(fakeBrowser.storage.sync, "set");
    await runStartupMigrations();
    expect(setSpy).not.toHaveBeenCalled();
    setSpy.mockRestore();
    const again = await getSettings();
    expect(again.perProvider.polly?.credentials.accessKeyId).toBe("AKIA");
  });

  it("keeps this device's local settings when sync is off; the flat keys convert into the sync item", async () => {
    // This device: sync off, current settings in local. Another device still
    // on a fork build: flat keys in sync, no settings object there yet.
    await syncEnabledItem.setValue(false);
    const local = { schemaVersion: 1, speed: 2, language: "de-DE" };
    await fakeBrowser.storage.local.set({ settings: local });
    await fakeBrowser.storage.sync.set({
      accessKeyId: "AKIA",
      secretAccessKey: "s",
      region: "us-east-1",
      voices: { "en-US": "Joanna" },
    });
    const syncSet = vi.spyOn(fakeBrowser.storage.sync, "set");
    const localSet = vi.spyOn(fakeBrowser.storage.local, "set");

    await runStartupMigrations();

    expect(localSet).not.toHaveBeenCalled();
    expect(syncSet).toHaveBeenCalledTimes(1);
    syncSet.mockRestore();
    localSet.mockRestore();

    expect((await fakeBrowser.storage.local.get("settings")).settings).toEqual(local);
    expect((await getSettings()).speed).toBe(2);
    const raw = await fakeBrowser.storage.sync.get(null);
    expect(raw.accessKeyId).toBeUndefined();
    expect(raw.voices).toBeUndefined();
    expect(raw.settings).toMatchObject({
      schemaVersion: SETTINGS_VERSION,
      perProvider: { polly: { credentials: { accessKeyId: "AKIA" } } },
      selection: { providerId: "polly", voiceId: "Joanna" },
    });
  });

  it("converts into the sync item even when sync is off and local is empty: the data belongs to the device that synced it", async () => {
    await syncEnabledItem.setValue(false);
    await fakeBrowser.storage.sync.set({ subscriptionKey: "k", region: "eastus" });

    await runStartupMigrations();

    expect((await fakeBrowser.storage.local.get("settings")).settings).toBeUndefined();
    const raw = await fakeBrowser.storage.sync.get(null);
    expect(raw.subscriptionKey).toBeUndefined();
    expect(raw.settings).toMatchObject({
      schemaVersion: SETTINGS_VERSION,
      perProvider: { azure: { credentials: { subscriptionKey: "k" } } },
    });
  });

  it("preserves unknown keys (non-destructive)", async () => {
    await fakeBrowser.storage.sync.set({
      subscriptionKey: "k",
      region: "eastus",
      someUnknownKey: "keep-me",
    });

    await runStartupMigrations();

    const raw = await fakeBrowser.storage.sync.get(null);
    expect(raw.someUnknownKey).toBe("keep-me");
  });

  it("up() is pure and idempotent: a versioned blob passes through untouched", () => {
    const flat = { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1" };
    const once = fromFlatKeys.up(flat);
    expect(once).toMatchObject({ schemaVersion: 1 });
    expect(fromFlatKeys.up(once)).toBe(once);
    // A v1 blob shares field names with the flat keys (language, speed,
    // credentialsValid); the version stamp, not those names, decides.
    const v1 = { schemaVersion: 1, language: "de-DE", speed: 2, credentialsValid: { polly: true } };
    expect(fromFlatKeys.up(v1)).toBe(v1);
  });
});

describe("presence-based provider detection", () => {
  it("keeps voices/settings for users with EMPTY credential keys", () => {
    // The old forks wrote empty-string credential keys at install time.
    const settings = settingsFromFlatKeys({
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

  it("rescues the oldest lineage's Google Cloud apiKey", () => {
    const settings = settingsFromFlatKeys({ apiKey: "AIzaLegacy" });
    expect(settings.credentials.google).toEqual({ apiKey: "AIzaLegacy" });
    expect(settings.credentialsValid.google).toBe(false);
  });

  it("coerces string-valued numeric fields instead of throwing", () => {
    const settings = settingsFromFlatKeys({
      subscriptionKey: "k",
      region: "eastus",
      speed: "1.5" as unknown as number,
      pitch: "abc" as unknown as number,
    });
    expect(settings.speed).toBe(1.5);
    expect(settings.pitch).toBe(0); // unparseable → default
  });
});
