import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { mergeSettings, parseImport } from "@/lib/settings-transfer";
import {
  DEFAULT_SETTINGS,
  getSettings,
  importBackupItem,
  readSettingsRecord,
  restoreSettingsBackup,
  SETTINGS_VERSION,
  type Settings,
  SettingsSchema,
  salvageSettingsPatch,
  setSettings,
  setSyncEnabled,
  voiceIssuesItem,
} from "@/lib/storage";
import { runStartupMigrations } from "@/migrations";
import type { SettingsV1 } from "@/migrations/000000";
import { nestVoiceIssues, splitVoiceIssueKey, toPerProvider } from "@/migrations/000001";
import { getProvider } from "@/providers";
import { PROVIDER_IDS } from "@/providers/types";
import { settingsV1 } from "../helpers/settings-v1";

const FIXTURES_DIR = resolve(__dirname, "fixtures");
const v1Export = readFileSync(resolve(FIXTURES_DIR, "v1.json"), "utf8");
const v1Blob = (JSON.parse(v1Export) as { settings: SettingsV1 }).settings;

function envelope(version: number, settings: unknown): string {
  return JSON.stringify({
    app: "cloud-speech",
    version,
    exportedAt: "2026-08-05T12:00:00.000Z",
    settings,
  });
}

const pollyEntry = {
  credentials: { accessKeyId: "AKIAEXAMPLE", secretAccessKey: "secret", region: "us-east-1" },
  verified: true,
  enabled: true,
};

describe("step 1: v1 -> v2", () => {
  it("folds the voice, model and style into one selection and the maps into one entry per provider", () => {
    expect(toPerProvider.up(v1Blob)).toEqual({
      schemaVersion: 2,
      perProvider: {
        polly: {
          ...pollyEntry,
          readAloudEncoding: "OGG_OPUS",
          downloadEncoding: "MP3_64_KBPS",
          lastModel: "neural",
        },
        azure: {
          credentials: { subscriptionKey: "azkey", region: "eastus" },
          verified: false,
          enabled: true,
        },
      },
      selection: { providerId: "polly", voiceId: "Joanna", model: "neural", style: "cheerful" },
      voicesByLanguage: v1Blob.voicesByLanguage,
      favorites: v1Blob.favorites,
      speed: 1.25,
      pitch: -2,
      volumeGainDb: 3,
      language: "en-US",
      theme: "dark",
      uiLanguage: "hi",
    });
  });

  it("without a selected voice: null selection, and the encodings have no provider to go to", () => {
    const { style: _style, ...rest } = v1Blob;
    const upgraded = toPerProvider.up({ ...rest, selectedVoice: null });
    expect(upgraded).toMatchObject({
      selection: null,
      perProvider: {
        polly: pollyEntry,
        azure: { credentials: { subscriptionKey: "azkey", region: "eastus" } },
      },
    });
    expect(JSON.stringify(upgraded)).not.toContain("Encoding");
  });

  it("carries only the keys the v1 blob had, so an import merge cannot clobber the rest", () => {
    expect(toPerProvider.up({ schemaVersion: 1, speed: 2 })).toEqual({
      schemaVersion: 2,
      speed: 2,
    });
    expect(toPerProvider.up({ speed: 2 })).toEqual({ schemaVersion: 2, speed: 2 });
    // An empty map still says "the user had provider state": an empty record.
    expect(toPerProvider.up({ schemaVersion: 1, credentials: {} })).toEqual({
      schemaVersion: 2,
      perProvider: {},
    });
  });

  it("defaults a selection stored without a model to the v1 default engine", () => {
    expect(
      toPerProvider.up({
        schemaVersion: 1,
        selectedVoice: { providerId: "azure", voiceId: "J" },
        credentials: { azure: { subscriptionKey: "k", region: "eastus" } },
      }),
    ).toEqual({
      schemaVersion: 2,
      selection: { providerId: "azure", voiceId: "J", model: "neural" },
      perProvider: {
        azure: {
          credentials: { subscriptionKey: "k", region: "eastus" },
          verified: false,
          enabled: false,
          lastModel: "neural",
        },
      },
    });
  });

  // Hand-trimmed or corrupt v1 files: pieces of provider state without a
  // valid credential record. None may produce an entry, because on an import
  // merge an entry replaces this device's whole entry for that provider. A
  // corrupt record is carried as one, so the v2 salvage drops it AND reports
  // it; flags alone are the deliberate cut (an entry is one value).
  it.each([
    [
      "a selection and its engine",
      { selectedVoice: { providerId: "polly", voiceId: "Joanna" }, model: "standard" },
      { selection: { providerId: "polly", voiceId: "Joanna", model: "standard" } },
      [],
    ],
    ["a verification flag", { credentialsValid: { polly: true } }, {}, []],
    ["an enable flag", { enabledProviders: { polly: true } }, {}, []],
    ["formats", { readAloudEncoding: "MP3", downloadEncoding: "MP3" }, {}, []],
    [
      "a null credential record",
      { credentials: { polly: null }, credentialsValid: { polly: true } },
      {},
      ["perProvider"],
    ],
    [
      "a credential record with a non-string value",
      { credentials: { polly: { accessKeyId: 42 } }, enabledProviders: { polly: true } },
      {},
      ["perProvider"],
    ],
  ])(
    "a v1 fragment carrying only %s produces no provider entry, so a merge keeps this device's",
    (_case, fragment, patch, dropped) => {
      const upgraded = toPerProvider.up({ schemaVersion: 1, ...fragment });
      expect(salvageSettingsPatch(upgraded)).toEqual({ patch, dropped });

      const current = SettingsSchema.parse(toPerProvider.up(v1Blob));
      const result = parseImport(envelope(1, { schemaVersion: 1, ...fragment }));
      if (!result.ok) throw new Error(result.error);
      expect(result.droppedFields).toEqual(dropped);
      expect(mergeSettings(current, result.patch).perProvider).toEqual(current.perProvider);
    },
  );

  it("a credential map with one corrupt record keeps the others and reports the loss", () => {
    const result = parseImport(
      envelope(1, {
        schemaVersion: 1,
        credentials: { openai: { apiKey: "working" }, azure: 42 },
        enabledProviders: { openai: true, azure: true },
      }),
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.patch.perProvider).toEqual({
      openai: { credentials: { apiKey: "working" }, verified: false, enabled: true },
    });
    expect(result.droppedFields).toEqual(["perProvider"]);
  });

  // A selection that does not name a usable voice is carried as it is, so the
  // v2 salvage drops it (reported) instead of a repaired replacement winning
  // an import merge.
  it.each([
    ["a corrupt voice id", { providerId: "polly", voiceId: 42 }],
    ["an empty voice id", { providerId: "polly", voiceId: "" }],
    ["an unknown provider", { providerId: "bogus", voiceId: "J" }],
    ["a non-object", "Joanna"],
  ])(
    "a v1 selection with %s is dropped and reported, so a merge keeps this device's",
    (_case, selectedVoice) => {
      const upgraded = toPerProvider.up({ schemaVersion: 1, selectedVoice, model: "neural" });
      expect(salvageSettingsPatch(upgraded)).toEqual({ patch: {}, dropped: ["selection"] });

      const current = SettingsSchema.parse(toPerProvider.up(v1Blob));
      const result = parseImport(envelope(1, { schemaVersion: 1, selectedVoice }));
      if (!result.ok) throw new Error(result.error);
      expect(result.droppedFields).toEqual(["selection"]);
      expect(mergeSettings(current, result.patch).selection).toEqual(current.selection);
    },
  );

  // Only an ABSENT model gets the v1 default (above); a stored one is carried
  // as it is. A made-up "neural" would win a merge over this device's engine
  // and, on a voice offering both engines, survive reconcile unnoticed.
  it.each([[42], [""], [null]])(
    "a v1 selection stored with model %j is dropped and reported, so a merge keeps this device's engine",
    (model) => {
      const selectedVoice = { providerId: "polly", voiceId: "Joanna" } as const;
      const upgraded = toPerProvider.up({ schemaVersion: 1, selectedVoice, model });
      expect(upgraded).toEqual({ schemaVersion: 2, selection: { ...selectedVoice, model } });
      expect(salvageSettingsPatch(upgraded)).toEqual({ patch: {}, dropped: ["selection"] });

      const current: Settings = {
        ...SettingsSchema.parse(toPerProvider.up(v1Blob)),
        selection: { ...selectedVoice, model: "standard" },
      };
      const result = parseImport(envelope(1, { schemaVersion: 1, selectedVoice, model }));
      if (!result.ok) throw new Error(result.error);
      expect(result.droppedFields).toEqual(["selection"]);
      expect(mergeSettings(current, result.patch).selection).toEqual({
        ...selectedVoice,
        model: "standard",
      });
    },
  );

  it("carries a corrupt style and corrupt formats as stored; the v2 schema lets those advisory fields fall back without costing the voice or the keys", () => {
    const selectedVoice = { providerId: "polly", voiceId: "Joanna" };
    const upgraded = toPerProvider.up({
      schemaVersion: 1,
      selectedVoice,
      model: "standard",
      style: 42,
      credentials: { polly: pollyEntry.credentials },
      readAloudEncoding: 42,
      downloadEncoding: null,
    });
    const entry = { credentials: pollyEntry.credentials, verified: false, enabled: false };
    expect(upgraded).toEqual({
      schemaVersion: 2,
      selection: { ...selectedVoice, model: "standard", style: 42 },
      perProvider: {
        polly: { ...entry, readAloudEncoding: 42, downloadEncoding: null, lastModel: "standard" },
      },
    });
    expect(salvageSettingsPatch(upgraded)).toEqual({
      patch: {
        selection: { ...selectedVoice, model: "standard" },
        perProvider: { polly: { ...entry, lastModel: "standard" } },
      },
      dropped: [],
    });
  });

  it("an explicit null selection is carried as null (the user had no voice)", () => {
    expect(toPerProvider.up({ schemaVersion: 1, selectedVoice: null })).toEqual({
      schemaVersion: 2,
      selection: null,
    });
  });

  it("a v1 fragment carrying credentials replaces the entry with untested, disabled ones", () => {
    const current = SettingsSchema.parse(toPerProvider.up(v1Blob));
    const result = parseImport(
      envelope(1, { schemaVersion: 1, credentials: { polly: pollyEntry.credentials } }),
    );
    if (!result.ok) throw new Error(result.error);
    // The file's keys win, and nothing vouches for them until Save & test.
    expect(mergeSettings(current, result.patch).perProvider).toEqual({
      ...current.perProvider,
      polly: { credentials: pollyEntry.credentials, verified: false, enabled: false },
    });
  });

  it("carries corrupt favorites as they are, for the salvage to drop and report", () => {
    const favorites = ["polly:Joanna", 42, null, "azure:Jenny"];
    const upgraded = toPerProvider.up({ schemaVersion: 1, favorites });
    expect(upgraded).toEqual({ schemaVersion: 2, favorites });
    expect(salvageSettingsPatch(upgraded)).toEqual({ patch: {}, dropped: ["favorites"] });
  });

  it("is idempotent on its own output and leaves any later version alone", () => {
    const once = toPerProvider.up(v1Blob);
    expect(toPerProvider.up(once)).toBe(once);
    const later = { schemaVersion: 3, anything: true };
    expect(toPerProvider.up(later)).toBe(later);
  });

  it.each([[0], [1.5], ["2"], [undefined]])(
    "converts a blob whose stamp %j the runner reads as v1",
    (stamp) => {
      expect(toPerProvider.up({ ...v1Blob, schemaVersion: stamp })).toEqual(
        toPerProvider.up(v1Blob),
      );
    },
  );

  it("a v1 export imports as the current shape, nothing dropped", () => {
    const result = parseImport(v1Export);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedFields).toEqual([]);
    expect(result.settings.selection).toEqual({
      providerId: "polly",
      voiceId: "Joanna",
      model: "neural",
      style: "cheerful",
    });
    expect(result.providersWithCredentials).toEqual(["polly", "azure"]);
  });

  it("arbitrary v1 blobs: the output strict-parses and every credentialed provider keeps an entry", () => {
    fc.assert(
      fc.property(settingsV1, (blob) => {
        const upgraded = toPerProvider.up(blob);
        const parsed = SettingsSchema.parse(upgraded);
        for (const id of PROVIDER_IDS) {
          const credentials = blob.credentials[id];
          if (!credentials) continue;
          expect(parsed.perProvider[id]).toMatchObject({
            credentials,
            enabled: blob.enabledProviders[id] === true,
            // The flag survives only with complete credentials.
            verified:
              blob.credentialsValid[id] === true && getProvider(id).hasCredentials(credentials),
          });
        }
        if (blob.selectedVoice) {
          expect(parsed.selection).toMatchObject(blob.selectedVoice);
          // The encodings travel with the selected provider's entry, when it has one.
          const selected = blob.selectedVoice.providerId;
          if (selected in blob.credentials) {
            expect(parsed.perProvider[selected]).toMatchObject({
              readAloudEncoding: blob.readAloudEncoding,
              downloadEncoding: blob.downloadEncoding,
            });
          } else {
            expect(parsed.perProvider[selected]).toBeUndefined();
          }
        } else {
          expect(parsed.selection).toBeNull();
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe("a v1 import backup", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  // Wholly corrupt v1 fragments: the step carries the corrupt value, the v2
  // salvage drops it, and a snapshot that salvages to nothing is refused.
  it.each([
    [
      "providers named but all corrupt",
      { credentials: { openai: null, polly: { accessKeyId: 42 } } },
      ["perProvider"],
    ],
    ["only unknown providers named", { credentials: { typo: { apiKey: "x" } } }, ["perProvider"]],
    ["a null credential map", { credentials: null }, ["perProvider"]],
    ["a numeric credential map", { credentials: 42 }, ["perProvider"]],
    ["an array credential map", { credentials: [] }, ["perProvider"]],
    ["a numeric flag map and no credentials", { credentialsValid: 42 }, []],
    ["corrupt favorites", { favorites: [42] }, ["favorites"]],
    ["a corrupt selection", { selectedVoice: "Joanna" }, ["selection"]],
  ])(
    "with %s is refused, not restored as defaults over real settings",
    async (_case, fragment, dropped) => {
      const current = SettingsSchema.parse(toPerProvider.up(v1Blob));
      await setSettings(current);
      expect(salvageSettingsPatch(toPerProvider.up({ schemaVersion: 1, ...fragment }))).toEqual({
        patch: {},
        dropped,
      });
      await importBackupItem.setValue({
        savedAt: "2026-08-05T12:00:00.000Z",
        settings: { schemaVersion: 1, ...fragment } as unknown as Settings,
      });

      expect(await restoreSettingsBackup()).toBeNull();
      expect(await importBackupItem.getValue()).toBeNull();
      expect(await getSettings()).toEqual(current);
    },
  );
});

describe("a stored v1 blob", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it.each([
    ["sync", true, 1],
    ["local", false, 1],
    // A malformed stamp reads as v1 everywhere: converted, never emptied.
    ["sync", true, 1.5],
  ] as const)(
    "in %s (stamped %j) upgrades on read and is written back exactly once",
    async (area, sync, stamp) => {
      await setSyncEnabled(sync);
      await fakeBrowser.storage[area].set({ settings: { ...v1Blob, schemaVersion: stamp } });
      const set = vi.spyOn(fakeBrowser.storage[area], "set");

      const [first, second] = await Promise.all([readSettingsRecord(), readSettingsRecord()]);
      const expected = SettingsSchema.parse(toPerProvider.up(v1Blob));
      expect(first).toEqual({ settings: expected, storedVersion: 1 });
      expect(second).toEqual(first);

      await vi.waitFor(async () => {
        expect((await fakeBrowser.storage[area].get("settings")).settings).toEqual(expected);
      });
      expect(set).toHaveBeenCalledTimes(1);
      // The next read finds a current blob: nothing more to write.
      expect(await readSettingsRecord()).toEqual({
        settings: expected,
        storedVersion: SETTINGS_VERSION,
      });
      expect(set).toHaveBeenCalledTimes(1);
    },
  );
});

describe("voice-issue cache reshape", () => {
  it.each([
    ["polly:Joanna:neural", { providerId: "polly", voiceId: "Joanna", model: "neural" }],
    // Google ids contain colons: the provider is before the FIRST, the model
    // after the LAST, and everything between is the voice id.
    [
      "google:projects/x/voices:weird:id:neural2",
      { providerId: "google", voiceId: "projects/x/voices:weird:id", model: "neural2" },
    ],
    ["nocolons", null],
    ["polly:onlyone", null],
    ["polly::neural", null],
    ["polly:Joanna:", null],
    ["bogus:Joanna:neural", null],
  ])("%s splits to %j", (key, expected) => {
    expect(splitVoiceIssueKey(key)).toEqual(expected);
  });

  it("nests a flat cache and passes a nested or empty one through", () => {
    expect(
      nestVoiceIssues({
        "polly:Joanna:neural": "e1",
        "polly:Joanna:standard": "e2",
        "google:projects/x/voices:weird:id:neural2": "e3",
        // Provider-supplied names that collide with Object's own members.
        "custom:__proto__:tts-1": "e4",
        "custom:alloy:constructor": "e5",
        garbage: "dropped",
      }),
    ).toEqual({
      polly: { Joanna: { neural: "e1", standard: "e2" } },
      google: { "projects/x/voices:weird:id": { neural2: "e3" } },
      custom: { ["__proto__"]: { "tts-1": "e4" }, alloy: { constructor: "e5" } },
    });
    expect(nestVoiceIssues({ polly: { Joanna: { neural: "e1" } } })).toBeNull();
    expect(nestVoiceIssues({})).toBeNull();
    expect(nestVoiceIssues(undefined)).toBeNull();
  });

  it("runs once at startup and leaves the reshaped cache alone afterwards", async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    await fakeBrowser.storage.local.set({
      voiceIssues: { "polly:Joanna:neural": "e1", "azure:en-US-JennyNeural:neural": "e2" },
    });

    await runStartupMigrations();
    const nested = {
      polly: { Joanna: { neural: "e1" } },
      azure: { "en-US-JennyNeural": { neural: "e2" } },
    };
    expect(await voiceIssuesItem.getValue()).toEqual(nested);

    const set = vi.spyOn(fakeBrowser.storage.local, "set");
    await runStartupMigrations();
    expect(set).not.toHaveBeenCalled();
    expect(await voiceIssuesItem.getValue()).toEqual(nested);
    // Settings were never touched: no blob, so still the defaults.
    expect((await readSettingsRecord()).settings).toEqual(DEFAULT_SETTINGS);
  });
});
