import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  buildExport,
  describeImportFailure,
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
  type SettingsInput,
  SettingsSchema,
  SYNC_QUOTA_BYTES_PER_ITEM,
  setSettings,
  setSettingsWithBackup,
  updateSettingsWith,
} from "@/lib/storage";

function settingsWith(patch: Partial<SettingsInput>): Settings {
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
      perProvider: { polly: { credentials: { accessKeyId: "AKIA", secretAccessKey: "shh" } } },
      favorites: ["polly:Joanna", "azure:en-US-JennyNeural"],
      selection: {
        providerId: "azure",
        voiceId: "en-US-JennyNeural",
        model: "neural",
        style: "cheerful",
      },
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

function expectRejected(result: ParseImportResult): Extract<ParseImportResult, { ok: false }> {
  if (result.ok) throw new Error("expected a rejected import");
  return result;
}

describe("parseImport rejection", () => {
  it("rejects invalid JSON, keeping the parser's message as detail", () => {
    const result = expectRejected(parseImport("not json{"));
    expect(result.error).toBe("not-json");
    expect(result.detail).toMatch(/SyntaxError/);
  });

  it("rejects a bare settings object (no envelope), naming the missing fields", () => {
    const result = expectRejected(parseImport(JSON.stringify(DEFAULT_SETTINGS)));
    expect(result.error).toBe("wrong-app");
    expect(result.detail).toContain("app");
    expect(result.detail).toContain("version");
  });

  it("rejects another app's envelope", () => {
    const result = expectRejected(parseImport(envelopeJson({}, { app: "other-ext" })));
    expect(result.error).toBe("wrong-app");
    expect(result.detail).toBe("Not an export envelope: app");
  });

  it("rejects a future version (envelope OR blob stamp) and accepts the current one", () => {
    const fromEnvelope = expectRejected(
      parseImport(envelopeJson({}, { version: SETTINGS_VERSION + 1 })),
    );
    expect(fromEnvelope.error).toBe("future-version");
    expect(fromEnvelope.detail).toBe(
      `File settings schema v${SETTINGS_VERSION + 1}; this build reads up to v${SETTINGS_VERSION}`,
    );
    const fromBlob = expectRejected(
      parseImport(envelopeJson({ schemaVersion: SETTINGS_VERSION + 3, speed: 2 })),
    );
    expect(fromBlob.error).toBe("future-version");
    expect(fromBlob.detail).toContain(`v${SETTINGS_VERSION + 3}`);
    expect(parseImport(envelopeJson({}, { version: SETTINGS_VERSION })).ok).toBe(true);
  });

  it("rejects non-object settings payloads, saying what type it found", () => {
    const number = expectRejected(parseImport(envelopeJson(42)));
    expect(number.error).toBe("nothing-salvageable");
    expect(number.detail).toBe('"settings" is number, not an object');
    const nul = expectRejected(parseImport(envelopeJson(null)));
    expect(nul.error).toBe("nothing-salvageable");
    expect(nul.detail).toBe('"settings" is null, not an object');
    expect(expectRejected(parseImport(envelopeJson("garbage"))).error).toBe("nothing-salvageable");
    expect(expectRejected(parseImport(envelopeJson([1]))).detail).toBe(
      '"settings" is an array, not an object',
    );
  });
});

describe("describeImportFailure", () => {
  it("one title for every kind, the kind's sentence, and the parser's detail", () => {
    const cases = [
      ["not-json", "settings.backup_import_not_json"],
      ["wrong-app", "settings.backup_import_wrong_app"],
      ["future-version", "settings.backup_import_future_version"],
      ["nothing-salvageable", "settings.backup_import_nothing"],
    ] as const;
    for (const [error, message] of cases) {
      expect(describeImportFailure({ ok: false, error, detail: `raw ${error}` })).toEqual({
        title: "settings.backup_import_failed_title",
        message,
        detail: `raw ${error}`,
      });
    }
  });

  it("carries a real parse result through unchanged", () => {
    const result = expectRejected(parseImport("{"));
    expect(describeImportFailure(result).detail).toBe(result.detail);
  });
});

describe("parseImport salvage", () => {
  it("keeps valid credentials and drops a corrupt scalar WITHOUT patching it", () => {
    const result = expectOk(
      parseImport(
        envelopeJson({
          perProvider: { polly: { credentials: { accessKeyId: "AKIA" } } },
          speed: "corrupt",
        }),
      ),
    );
    expect(result.patch.perProvider?.polly?.credentials.accessKeyId).toBe("AKIA");
    expect(result.droppedFields).toContain("speed");
    // Merge must not default-clobber the current speed.
    expect("speed" in result.patch).toBe(false);
  });

  it("rescues the other entries around a corrupt provider entry", () => {
    const result = expectOk(
      parseImport(
        envelopeJson({
          perProvider: { polly: { credentials: { accessKeyId: "AKIA" } }, azure: { key: 42 } },
        }),
      ),
    );
    expect(result.patch.perProvider).toEqual({
      polly: { credentials: { accessKeyId: "AKIA" }, verified: false, enabled: false },
    });
    expect(result.droppedFields).toContain("perProvider");
  });

  it("a file entry without credentials is no entry: a merge keeps this device's keys", () => {
    const current = settingsWith({
      perProvider: { openai: { credentials: { apiKey: "mine" }, verified: true, enabled: true } },
    });
    const result = expectOk(
      parseImport(envelopeJson({ perProvider: { openai: { verified: true } } })),
    );
    expect(result.droppedFields).toEqual(["perProvider"]);
    expect(mergeSettings(current, result.patch).perProvider).toEqual(current.perProvider);
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
          perProvider: {
            polly: { credentials: { accessKeyId: "AKIA" } },
            azure: { credentials: {} },
            openai: { credentials: { apiKey: "  " } },
          },
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
      perProvider: {
        polly: { credentials: { accessKeyId: "mine" }, verified: true, downloadEncoding: "MP3" },
        openai: { credentials: { apiKey: "keep" } },
      },
      voicesByLanguage: { "en-US": { providerId: "polly", voiceId: "Joanna" } },
    });
    const merged = mergeSettings(current, {
      perProvider: {
        polly: { credentials: { accessKeyId: "theirs" }, verified: false, enabled: true },
      },
      voicesByLanguage: { "de-DE": { providerId: "azure", voiceId: "de-DE-KatjaNeural" } },
    });
    // The file's whole entry replaces this device's: its flag describes its
    // own keys, and the device's flag never vouches for keys it did not test.
    expect(merged.perProvider).toEqual({
      polly: { credentials: { accessKeyId: "theirs" }, verified: false, enabled: true },
      openai: { credentials: { apiKey: "keep" }, verified: false, enabled: false },
    });
    expect(merged.voicesByLanguage["en-US"]?.voiceId).toBe("Joanna");
    expect(merged.voicesByLanguage["de-DE"]?.voiceId).toBe("de-DE-KatjaNeural");
  });

  it("unions favorites, current order first, deduped", () => {
    const current = settingsWith({ favorites: ["polly:Joanna", "azure:Jenny"] });
    const merged = mergeSettings(current, { favorites: ["azure:Jenny", "openai:alloy"] });
    expect(merged.favorites).toEqual(["polly:Joanna", "azure:Jenny", "openai:alloy"]);
  });

  it("always emits schema-valid output for odd-but-valid inputs", () => {
    const merged = mergeSettings(
      settingsWith({
        selection: { providerId: "polly", voiceId: "Joanna", model: "neural", style: "x" },
      }),
      {
        selection: { providerId: "custom", voiceId: "x:with:colons", model: "tts-1" },
        favorites: [""],
      },
    );
    expect(SettingsSchema.parse(merged)).toEqual(merged);
    expect(merged.selection).toEqual({
      providerId: "custom",
      voiceId: "x:with:colons",
      model: "tts-1",
    });
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
    await setSettings(
      settingsWith({ speed: 2, perProvider: { polly: { credentials: { accessKeyId: "mine" } } } }),
    );
    const { patch } = expectOk(
      parseImport(
        envelopeJson({ pitch: 3, perProvider: { azure: { credentials: { key: "theirs" } } } }),
      ),
    );
    await updateSettingsWith((current) => mergeSettings(current, patch));

    const settings = await getSettings();
    expect(settings.speed).toBe(2);
    expect(settings.pitch).toBe(3);
    expect(settings.perProvider.polly?.credentials.accessKeyId).toBe("mine");
    expect(settings.perProvider.azure?.credentials.key).toBe("theirs");
  });

  it("replace via setSettingsWithBackup clears a selection the file lacks", async () => {
    await setSettings(
      settingsWith({
        selection: { providerId: "polly", voiceId: "Joanna", model: "neural" },
        speed: 2,
      }),
    );
    const parsed = expectOk(parseImport(envelopeJson({ speed: 1.5 })));
    await setSettingsWithBackup(() => parsed.settings, new Date("2026-08-05T00:00:00.000Z"));

    const settings = await getSettings();
    expect(settings.speed).toBe(1.5);
    expect(settings.selection).toBeNull();
  });
});
