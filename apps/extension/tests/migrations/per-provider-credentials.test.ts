import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { isRecord } from "@/lib/messaging/record";
import { NEVER_SUPERSEDED } from "@/lib/messaging/slot";
import { mergeSettings, parseImport } from "@/lib/settings/settings-transfer";
import {
  DEFAULT_SETTINGS,
  getSettings,
  importBackupItem,
  ProviderPrefsSchema,
  readSettingsRecord,
  readVoiceIssues,
  restoreSettingsBackup,
  type Settings,
  SettingsSchema,
  salvageSettingsPatch,
  setSyncEnabled,
  voiceIssuesItem,
} from "@/lib/settings/storage";
import { runStartupMigrations } from "@/migrations";
import type { SettingsV1 } from "@/migrations/flat-keys-to-settings-object";
import { SETTINGS_VERSION } from "@/migrations/ladder";
import {
  nestVoiceIssues,
  perProviderCredentials,
  splitVoiceIssueKey,
} from "@/migrations/per-provider-credentials";
import { getProvider } from "@/providers";
import { hasAllCredentialFields, PROVIDER_IDS } from "@/providers/types";
import { seedSettings } from "../helpers/seed-settings";
import { corruptSettingsV1, settingsV1 } from "../helpers/settings-v1";

const FIXTURES_DIR = resolve(__dirname, "fixtures");
const v1Export = readFileSync(resolve(FIXTURES_DIR, "v1.json"), "utf8");
const v1Blob = (JSON.parse(v1Export) as { settings: SettingsV1 }).settings;
const ENCODING_KEYS = ["readAloudEncoding", "downloadEncoding"] as const;

/** What one v2 entry must hold, read from the v1 blob: the id it sits under, the stored credentials (corrupt or
 *  not), and whether it is the selected voice's entry, which alone carries the formats and the engine. */
interface EntryExpectation {
  id: string;
  credentials: unknown;
  carriesSelection: boolean;
}

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

/** Every credentialed provider keeps an entry: its credentials, its enabled flag, and a verified flag that survives
 *  only with complete credentials. */
function expectCredentialedEntries(blob: SettingsV1, parsed: Settings): void {
  for (const id of PROVIDER_IDS) {
    const credentials = blob.credentials[id];
    if (!credentials) continue;
    expect(parsed.perProvider[id]).toMatchObject({
      credentials,
      enabled: blob.enabledProviders[id] === true,
      verified:
        blob.credentialsValid[id] === true &&
        hasAllCredentialFields(getProvider(id).credentialSchema, credentials),
    });
  }
}

/** The selection is carried as stored, and the encodings travel with the selected provider's entry, when it has one. */
function expectSelectionCarried(blob: SettingsV1, parsed: Settings): void {
  if (!blob.selectedVoice) {
    expect(parsed.selection).toBeNull();
    return;
  }

  expect(parsed.selection).toMatchObject(blob.selectedVoice);
  const selected = blob.selectedVoice.providerId;
  if (selected in blob.credentials) {
    expect(parsed.perProvider[selected]).toMatchObject({
      readAloudEncoding: blob.readAloudEncoding,
      downloadEncoding: blob.downloadEncoding,
    });
  } else {
    expect(parsed.perProvider[selected]).toBeUndefined();
  }
}

describe("step 1: v1 -> v2", () => {
  it("folds the voice, model and style into one selection and the maps into one entry per provider", () => {
    expect(perProviderCredentials.up(v1Blob)).toEqual({
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
    const upgraded = perProviderCredentials.up({ ...rest, selectedVoice: null });
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
    expect(perProviderCredentials.up({ schemaVersion: 1, speed: 2 })).toEqual({
      schemaVersion: 2,
      speed: 2,
    });
    expect(perProviderCredentials.up({ speed: 2 })).toEqual({ schemaVersion: 2, speed: 2 });
    // An empty map still says "the user had provider state": an empty record.
    expect(perProviderCredentials.up({ schemaVersion: 1, credentials: {} })).toEqual({
      schemaVersion: 2,
      perProvider: {},
    });
  });

  it("defaults a selection stored without a model to the v1 default engine", () => {
    expect(
      perProviderCredentials.up({
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

  // On an import merge an entry replaces this device's whole entry for that provider, so v1 provider state without a valid
  // credential record may produce no entry (an entry is one value).
  //   flags or formats alone  -> no entry, nothing reported
  //   a corrupt record        -> carried as one, so the v2 salvage drops AND reports it
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
      const upgraded = perProviderCredentials.up({ schemaVersion: 1, ...fragment });
      expect(salvageSettingsPatch(upgraded)).toEqual({ patch, dropped });

      const current = SettingsSchema.parse(perProviderCredentials.up(v1Blob));
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

  // A selection that does not name a usable voice is carried as it is, so the v2 salvage drops it (reported)
  // instead of a repaired replacement winning an import merge.
  it.each([
    ["a corrupt voice id", { providerId: "polly", voiceId: 42 }],
    ["an empty voice id", { providerId: "polly", voiceId: "" }],
    ["an unknown provider", { providerId: "bogus", voiceId: "J" }],
    ["a non-object", "Joanna"],
  ])(
    "a v1 selection with %s is dropped and reported, so a merge keeps this device's",
    (_case, selectedVoice) => {
      const upgraded = perProviderCredentials.up({
        schemaVersion: 1,
        selectedVoice,
        model: "neural",
      });
      expect(salvageSettingsPatch(upgraded)).toEqual({ patch: {}, dropped: ["selection"] });

      const current = SettingsSchema.parse(perProviderCredentials.up(v1Blob));
      const result = parseImport(envelope(1, { schemaVersion: 1, selectedVoice }));
      if (!result.ok) throw new Error(result.error);
      expect(result.droppedFields).toEqual(["selection"]);
      expect(mergeSettings(current, result.patch).selection).toEqual(current.selection);
    },
  );

  // Only an ABSENT model gets the v1 default (above); a stored one is carried as it is. A made-up "neural" would win
  // a merge over this device's engine and, on a voice offering both engines, survive reconcile unnoticed.
  it.each([[42], [""], [null]])(
    "a v1 selection stored with model %j is dropped and reported, so a merge keeps this device's engine",
    (model) => {
      const selectedVoice = { providerId: "polly", voiceId: "Joanna" } as const;
      const upgraded = perProviderCredentials.up({ schemaVersion: 1, selectedVoice, model });
      expect(upgraded).toEqual({ schemaVersion: 2, selection: { ...selectedVoice, model } });
      expect(salvageSettingsPatch(upgraded)).toEqual({ patch: {}, dropped: ["selection"] });

      const current: Settings = {
        ...SettingsSchema.parse(perProviderCredentials.up(v1Blob)),
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
    const upgraded = perProviderCredentials.up({
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
    expect(perProviderCredentials.up({ schemaVersion: 1, selectedVoice: null })).toEqual({
      schemaVersion: 2,
      selection: null,
    });
  });

  it("a v1 fragment carrying credentials replaces the entry with untested, disabled ones", () => {
    const current = SettingsSchema.parse(perProviderCredentials.up(v1Blob));
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
    const upgraded = perProviderCredentials.up({ schemaVersion: 1, favorites });
    expect(upgraded).toEqual({ schemaVersion: 2, favorites });
    expect(salvageSettingsPatch(upgraded)).toEqual({ patch: {}, dropped: ["favorites"] });
  });

  it("is idempotent on its own output and leaves any later version alone", () => {
    const once = perProviderCredentials.up(v1Blob);
    expect(perProviderCredentials.up(once)).toBe(once);
    const later = { schemaVersion: 3, anything: true };
    expect(perProviderCredentials.up(later)).toBe(later);
  });

  it.each([[0], [1.5], ["2"], [undefined]])(
    "converts a blob whose stamp %j the runner reads as v1",
    (stamp) => {
      expect(perProviderCredentials.up({ ...v1Blob, schemaVersion: stamp })).toEqual(
        perProviderCredentials.up(v1Blob),
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
        const upgraded = perProviderCredentials.up(blob);
        const parsed = SettingsSchema.parse(upgraded);
        expectCredentialedEntries(blob, parsed);
        expectSelectionCarried(blob, parsed);
      }),
      { numRuns: 200 },
    );
  });
});

function asRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`expected a record, got ${JSON.stringify(value)}`);
  return value;
}

/** The step is pure: frozen input makes a coercion written INTO the blob throw instead of rewriting the expected values read from it afterwards. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value)) deepFreeze(nested);
  }
  return Object.freeze(value);
}

/** `{ present, value }`, so an absent slot and one holding undefined read apart. */
function slot(record: Record<string, unknown>, key: string) {
  return Object.hasOwn(record, key) ? { present: true, value: record[key] } : { present: false };
}

const V1_DEFAULT_MODEL = "neural";
const CARRIED_KEYS = [
  "voicesByLanguage",
  "favorites",
  "speed",
  "pitch",
  "volumeGainDb",
  "language",
  "theme",
  "uiLanguage",
] as const;

/** The engine v1 stored: it defaulted the field, so a blob without a `model` key stored the default. */
function storedModel(blob: Record<string, unknown>): unknown {
  return Object.hasOwn(blob, "model") ? blob.model : V1_DEFAULT_MODEL;
}

/** The v2 key set: the carried keys the blob holds, and a slot for each folded group it holds. */
function reshapedKeys(blob: Record<string, unknown>): string[] {
  const keys: string[] = [
    "schemaVersion",
    ...CARRIED_KEYS.filter((key) => Object.hasOwn(blob, key)),
  ];
  if (Object.hasOwn(blob, "credentials")) keys.push("perProvider");
  if (Object.hasOwn(blob, "selectedVoice")) keys.push("selection");
  return keys.sort();
}

/** The selection folds the voice, the engine, and the style (only when stored) into one record; a voice slot that
 *  holds no record reaches the selection slot as it is. */
function expectSelectionReshaped(
  blob: Record<string, unknown>,
  upgraded: Record<string, unknown>,
): void {
  const voice = slot(blob, "selectedVoice");
  if (!voice.present || !isRecord(voice.value)) {
    expect(slot(upgraded, "selection")).toStrictEqual(voice);
    return;
  }

  const style = slot(blob, "style");
  const selection = asRecord(upgraded.selection);
  const keys = ["providerId", "voiceId", "model"];
  if (style.present) keys.push("style");
  expect(Object.keys(selection).sort()).toStrictEqual(keys.sort());
  expect(selection.providerId).toStrictEqual(voice.value.providerId);
  expect(selection.voiceId).toStrictEqual(voice.value.voiceId);
  expect(selection.model).toStrictEqual(storedModel(blob));
  expect(slot(selection, "style")).toStrictEqual(style);
}

/** The flags are the one folded field: `z.boolean().default(false).catch(false)` parses every input except true to
 *  false, so the step's boolean and the stored flag passed through must parse to the same output, for any input. */
function expectFlagsReshaped(
  blob: Record<string, unknown>,
  id: string,
  entry: Record<string, unknown>,
): void {
  for (const [flag, map] of [
    ["verified", blob.credentialsValid],
    ["enabled", blob.enabledProviders],
  ] as const) {
    const stored = isRecord(map) ? map[id] : undefined;
    expect(ProviderPrefsSchema.shape[flag].parse(entry[flag])).toBe(
      ProviderPrefsSchema.shape[flag].parse(stored),
    );
  }
}

function expectEntryReshaped(
  blob: Record<string, unknown>,
  entry: Record<string, unknown>,
  { id, credentials, carriesSelection }: EntryExpectation,
): void {
  const keys = ["credentials", "verified", "enabled"];
  if (carriesSelection) {
    keys.push(...ENCODING_KEYS.filter((key) => Object.hasOwn(blob, key)), "lastModel");
  }
  expect(Object.keys(entry).sort()).toStrictEqual(keys.sort());
  expect(entry.credentials).toStrictEqual(credentials);
  expectFlagsReshaped(blob, id, entry);

  const absent = { present: false };
  for (const key of ENCODING_KEYS) {
    expect(slot(entry, key)).toStrictEqual(carriesSelection ? slot(blob, key) : absent);
  }
  expect(slot(entry, "lastModel")).toStrictEqual(
    carriesSelection ? { present: true, value: storedModel(blob) } : absent,
  );
}

/** One entry per stored credentials key; the formats and the engine land on the entry whose key equals the selected
 *  voice's provider id, known or not, and a non-string id names none. */
function expectPerProviderReshaped(
  blob: Record<string, unknown>,
  upgraded: Record<string, unknown>,
): void {
  const credentials = slot(blob, "credentials");
  if (!credentials.present || !isRecord(credentials.value)) {
    expect(slot(upgraded, "perProvider")).toStrictEqual(credentials);
    return;
  }

  const perProvider = asRecord(upgraded.perProvider);
  const ids = Object.keys(credentials.value);
  expect(Object.keys(perProvider).sort()).toStrictEqual([...ids].sort());

  const voice = slot(blob, "selectedVoice");
  const selectedProviderId = isRecord(voice.value) ? voice.value.providerId : undefined;
  for (const id of ids) {
    expectEntryReshaped(blob, asRecord(perProvider[id]), {
      id,
      credentials: credentials.value[id],
      carriesSelection: id === selectedProviderId,
    });
  }
}

/** The step's contract for one v1 field: present in the blob, so present at its v2 slot with the stored value (corrupt or
 *  not); absent, so absent. The step adds only two things: the v1 default engine for a blob without a `model` key
 *  (v1 defaulted the field, so absence WAS the value), and each entry's verified and enabled flags (checked against the flag maps). */
function expectReshaped(blob: Record<string, unknown>, upgraded: Record<string, unknown>): void {
  expect(Object.keys(upgraded).sort()).toStrictEqual(reshapedKeys(blob));
  expect(upgraded.schemaVersion).toBe(2);
  for (const key of CARRIED_KEYS) expect(slot(upgraded, key)).toStrictEqual(slot(blob, key));

  expectSelectionReshaped(blob, upgraded);
  expectPerProviderReshaped(blob, upgraded);
}

describe("step 1 reshapes and never validates", () => {
  it("any v1 blob with corrupt or missing fields: each stored value reaches its v2 slot as it is, an absent one stays absent, and the output is stable", () => {
    fc.assert(
      fc.property(corruptSettingsV1, (candidate) => {
        const blob = deepFreeze(candidate);
        const upgraded = asRecord(perProviderCredentials.up(blob));
        expect(perProviderCredentials.up(upgraded)).toBe(upgraded);
        expectReshaped(blob, upgraded);
      }),
      { numRuns: 500 },
    );
  });
});

describe("a v1 import backup", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

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
      const current = SettingsSchema.parse(perProviderCredentials.up(v1Blob));
      await seedSettings(current);
      expect(
        salvageSettingsPatch(perProviderCredentials.up({ schemaVersion: 1, ...fragment })),
      ).toEqual({
        patch: {},
        dropped,
      });
      await fakeBrowser.storage.local.set({
        importBackup: {
          savedAt: "2026-08-05T12:00:00.000Z",
          settings: { schemaVersion: 1, ...fragment } as unknown as Settings,
        },
      });

      expect(await restoreSettingsBackup(NEVER_SUPERSEDED)).toBeNull();
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
      await setSyncEnabled(NEVER_SUPERSEDED, sync);
      await fakeBrowser.storage[area].set({ settings: { ...v1Blob, schemaVersion: stamp } });
      const set = vi.spyOn(fakeBrowser.storage[area], "set");

      const [first, second] = await Promise.all([readSettingsRecord(), readSettingsRecord()]);
      const expected = SettingsSchema.parse(perProviderCredentials.up(v1Blob));
      expect(first).toEqual({ settings: expected, storedVersion: 1 });
      expect(second).toEqual(first);

      await vi.waitFor(async () => {
        expect((await fakeBrowser.storage[area].get("settings")).settings).toEqual(expected);
      });
      expect(set).toHaveBeenCalledTimes(1);
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
    // Google ids contain colons: the provider is before the FIRST, the model after the LAST, and everything between is the voice id.
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
    // The text leaves this step writes are not described failures: the reader shows no mark for them until the next failed preview or scan.
    expect(await readVoiceIssues()).toEqual({});

    const set = vi.spyOn(fakeBrowser.storage.local, "set");
    await runStartupMigrations();
    expect(set).not.toHaveBeenCalled();
    expect(await voiceIssuesItem.getValue()).toEqual(nested);
    expect((await readSettingsRecord()).settings).toEqual(DEFAULT_SETTINGS);
  });
});
