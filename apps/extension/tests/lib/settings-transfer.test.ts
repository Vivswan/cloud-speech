import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  buildExport,
  EXPORT_APP_ID,
  exportFilename,
  mergeSettings,
  type ParseImportResult,
  parseImport,
  serializeExport,
} from "@/lib/settings-transfer";
import {
  DEFAULT_SETTINGS,
  estimateSyncSizeBytes,
  getSettings,
  SETTINGS_VERSION,
  type Settings,
  SettingsSchema,
  SYNC_QUOTA_BYTES_PER_ITEM,
  setSettings,
  setSettingsWithBackup,
  updateSettingsWith,
} from "@/lib/storage";

function settingsWith(patch: Partial<Settings>): Settings {
  return SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...patch });
}

function envelopeJson(settings: unknown, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    app: EXPORT_APP_ID,
    version: SETTINGS_VERSION,
    exportedAt: "2026-08-05T12:00:00.000Z",
    settings,
    ...overrides,
  });
}

function expectOk(result: ParseImportResult): Extract<ParseImportResult, { ok: true }> {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}`);
  return result;
}

describe("export", () => {
  it("round-trips through serialize and parseImport", () => {
    const settings = settingsWith({
      credentials: { polly: { accessKeyId: "AKIA", secretAccessKey: "shh" } },
      favorites: ["polly:Joanna", "azure:en-US-JennyNeural"],
      style: "cheerful",
      speed: 1.5,
    });
    const now = new Date("2026-08-05T12:34:56.000Z");

    const result = expectOk(parseImport(serializeExport(buildExport(settings, now))));
    expect(result.settings).toEqual(settings);
    expect(result.droppedFields).toEqual([]);
    expect(result.exportedAt).toBe(now.toISOString());
    expect(result.providersWithCredentials).toEqual(["polly"]);
  });

  it("serializes pretty-printed", () => {
    const json = serializeExport(buildExport(DEFAULT_SETTINGS, new Date(0)));
    expect(json).toContain('\n  "app": "cloud-speech",');
    expect(json).toContain('\n  "settings": {');
  });

  it("names the file after the LOCAL date, zero-padded", () => {
    expect(exportFilename(new Date(2026, 7, 5))).toBe("cloud-speech-settings-2026-08-05.json");
  });
});

describe("parseImport rejection", () => {
  it("rejects invalid JSON", () => {
    expect(parseImport("not json{")).toEqual({ ok: false, error: "not-json" });
  });

  it("rejects a bare settings object (no envelope)", () => {
    expect(parseImport(JSON.stringify(DEFAULT_SETTINGS))).toEqual({
      ok: false,
      error: "wrong-app",
    });
  });

  it("rejects another app's envelope", () => {
    expect(parseImport(envelopeJson({}, { app: "other-ext" }))).toEqual({
      ok: false,
      error: "wrong-app",
    });
  });

  it("rejects a future version and accepts the current one", () => {
    expect(parseImport(envelopeJson({}, { version: SETTINGS_VERSION + 1 }))).toEqual({
      ok: false,
      error: "future-version",
    });
    expect(parseImport(envelopeJson({}, { version: SETTINGS_VERSION })).ok).toBe(true);
  });

  it("rejects non-object settings payloads", () => {
    expect(parseImport(envelopeJson(42))).toEqual({ ok: false, error: "nothing-salvageable" });
    expect(parseImport(envelopeJson("garbage"))).toEqual({
      ok: false,
      error: "nothing-salvageable",
    });
  });
});

describe("parseImport salvage", () => {
  it("keeps valid credentials and drops a corrupt scalar WITHOUT patching it", () => {
    const result = expectOk(
      parseImport(
        envelopeJson({ credentials: { polly: { accessKeyId: "AKIA" } }, speed: "corrupt" }),
      ),
    );
    expect(result.patch.credentials?.polly?.accessKeyId).toBe("AKIA");
    expect(result.droppedFields).toContain("speed");
    // Merge must not default-clobber the current speed.
    expect("speed" in result.patch).toBe(false);
  });

  it("rescues the other entries around a corrupt credential entry", () => {
    const result = expectOk(
      parseImport(
        envelopeJson({ credentials: { polly: { accessKeyId: "AKIA" }, azure: { key: 42 } } }),
      ),
    );
    expect(result.patch.credentials).toEqual({ polly: { accessKeyId: "AKIA" } });
    expect(result.droppedFields).toContain("credentials");
  });

  it("accepts an empty settings object as a legal (empty) backup", () => {
    const result = expectOk(parseImport(envelopeJson({})));
    expect(result.patch).toEqual({});
    expect(result.settings).toEqual(DEFAULT_SETTINGS);
    expect(result.providersWithCredentials).toEqual([]);
  });

  it("excludes providers whose credential record is empty or blank", () => {
    const result = expectOk(
      parseImport(
        envelopeJson({
          credentials: { polly: { accessKeyId: "AKIA" }, azure: {}, openai: { apiKey: "  " } },
        }),
      ),
    );
    expect(result.providersWithCredentials).toEqual(["polly"]);
  });
});

describe("mergeSettings", () => {
  it("lets patch scalars win and keeps current values for absent keys", () => {
    const current = settingsWith({ speed: 2, theme: "dark", language: "de-DE" });
    const merged = mergeSettings(current, { speed: 1.25, uiLanguage: "hi" });
    expect(merged.speed).toBe(1.25);
    expect(merged.uiLanguage).toBe("hi");
    expect(merged.theme).toBe("dark");
    expect(merged.language).toBe("de-DE");
  });

  it("merges records per entry: file wins, current-only entries kept", () => {
    const current = settingsWith({
      credentials: { polly: { accessKeyId: "mine" }, openai: { apiKey: "keep" } },
      voicesByLanguage: { "en-US": { providerId: "polly", voiceId: "Joanna" } },
    });
    const merged = mergeSettings(current, {
      credentials: { polly: { accessKeyId: "theirs" } },
      voicesByLanguage: { "de-DE": { providerId: "azure", voiceId: "de-DE-KatjaNeural" } },
    });
    expect(merged.credentials.polly).toEqual({ accessKeyId: "theirs" });
    expect(merged.credentials.openai).toEqual({ apiKey: "keep" });
    expect(merged.voicesByLanguage["en-US"]?.voiceId).toBe("Joanna");
    expect(merged.voicesByLanguage["de-DE"]?.voiceId).toBe("de-DE-KatjaNeural");
  });

  it("unions favorites, current order first, deduped", () => {
    const current = settingsWith({ favorites: ["polly:Joanna", "azure:Jenny"] });
    const merged = mergeSettings(current, { favorites: ["azure:Jenny", "openai:alloy"] });
    expect(merged.favorites).toEqual(["polly:Joanna", "azure:Jenny", "openai:alloy"]);
  });

  it("always emits schema-valid output for odd-but-valid inputs", () => {
    const merged = mergeSettings(settingsWith({ style: "cheerful" }), {
      selectedVoice: { providerId: "custom", voiceId: "x:with:colons" },
      style: undefined,
      favorites: [""],
    });
    expect(SettingsSchema.parse(merged)).toEqual(merged);
    expect(merged.style).toBeUndefined();
    expect(merged.selectedVoice).toEqual({ providerId: "custom", voiceId: "x:with:colons" });
  });

  it("does not carry a validated flag onto credentials the file changed", () => {
    const current = settingsWith({
      credentials: { polly: { accessKeyId: "mine" } },
      credentialsValid: { polly: true },
    });
    expect(
      mergeSettings(current, { credentials: { polly: { accessKeyId: "theirs" } } }).credentialsValid
        .polly,
    ).toBe(false);
    expect(
      mergeSettings(current, { credentials: { polly: { accessKeyId: "mine" } } }).credentialsValid
        .polly,
    ).toBe(true);
    expect(
      mergeSettings(current, {
        credentials: { polly: { accessKeyId: "theirs" } },
        credentialsValid: { polly: true },
      }).credentialsValid.polly,
    ).toBe(true);
  });

  it("ignores a validity flag for a provider whose credentials the file lacks", () => {
    const current = settingsWith({
      credentials: { polly: { accessKeyId: "mine" } },
      credentialsValid: { polly: false },
    });
    const merged = mergeSettings(current, { credentialsValid: { polly: true, azure: true } });
    expect(merged.credentialsValid.polly).toBe(false);
    expect(merged.credentialsValid.azure).toBeUndefined();
    expect(merged.credentials.polly).toEqual({ accessKeyId: "mine" });
  });

  it("can exceed the sync quota (the UI pre-checks with estimateSyncSizeBytes)", () => {
    const huge = Array.from({ length: 400 }, (_, i) => `polly:Voice-${i}-${"x".repeat(24)}`);
    const merged = mergeSettings(DEFAULT_SETTINGS, { favorites: huge });
    expect(estimateSyncSizeBytes(merged)).toBeGreaterThan(SYNC_QUOTA_BYTES_PER_ITEM);
  });
});

describe("applying imports through storage", () => {
  beforeEach(() => fakeBrowser.reset());

  it("merge patch applied via updateSettingsWith", async () => {
    await setSettings(settingsWith({ speed: 2, credentials: { polly: { accessKeyId: "mine" } } }));
    const { patch } = expectOk(
      parseImport(envelopeJson({ pitch: 3, credentials: { azure: { key: "theirs" } } })),
    );
    await updateSettingsWith((current) => mergeSettings(current, patch));

    const settings = await getSettings();
    expect(settings.speed).toBe(2);
    expect(settings.pitch).toBe(3);
    expect(settings.credentials.polly?.accessKeyId).toBe("mine");
    expect(settings.credentials.azure?.key).toBe("theirs");
  });

  it("replace via setSettingsWithBackup clears a style the file lacks", async () => {
    await setSettings(settingsWith({ style: "cheerful", speed: 2 }));
    const parsed = expectOk(parseImport(envelopeJson({ speed: 1.5 })));
    await setSettingsWithBackup(() => parsed.settings, new Date("2026-08-05T00:00:00.000Z"));

    const settings = await getSettings();
    expect(settings.speed).toBe(1.5);
    expect(settings.style).toBeUndefined();
  });
});
