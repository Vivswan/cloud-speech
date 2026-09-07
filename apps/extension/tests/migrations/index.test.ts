import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { EXTENSION_LOCALE_IDS } from "@cloud-speech/constants";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseImport } from "@/lib/settings-transfer";
import { SETTINGS_VERSION, type Settings, SettingsSchema } from "@/lib/storage";
import {
  dueMigrations,
  MIGRATIONS,
  peekSchemaVersion,
  type SettingsMigration,
  SettingsNewerError,
  upgradeSettingsBlob,
} from "@/migrations";
import type { SettingsV1 } from "@/migrations/000000";
import { PROVIDER_IDS } from "@/providers/types";

const FIXTURES_DIR = resolve(__dirname, "fixtures");

/** Every SettingsV1 key except the optional `style`. */
const V1_REQUIRED_KEYS = [
  "schemaVersion",
  "credentials",
  "credentialsValid",
  "enabledProviders",
  "selectedVoice",
  "voicesByLanguage",
  "favorites",
  "model",
  "speed",
  "pitch",
  "volumeGainDb",
  "readAloudEncoding",
  "downloadEncoding",
  "language",
  "theme",
  "uiLanguage",
] as const satisfies readonly (keyof SettingsV1)[];

/** One export envelope per schema version ever shipped, v<N>.json, all
 *  describing the SAME user's settings; current.json is those settings in
 *  the current shape, so every fixture must upgrade to exactly it. */
const CURRENT: Settings = SettingsSchema.parse(
  JSON.parse(readFileSync(resolve(FIXTURES_DIR, "current.json"), "utf8")),
);
const fixtures = readdirSync(FIXTURES_DIR)
  .filter((file) => /^v\d+\.json$/.test(file))
  .map((file) => ({
    file,
    version: Number(/^v(\d+)\.json$/.exec(file)?.[1]),
    text: readFileSync(resolve(FIXTURES_DIR, file), "utf8"),
  }));

function fixtureBlob(text: string): unknown {
  return (JSON.parse(text) as { settings: unknown }).settings;
}

// --- Arbitrary v1 blobs, mirroring the FROZEN SettingsV1 shape (never the
// live schema: after a version bump the live schema would reject every v1
// candidate and the property would run on nothing). ---

const providerId = fc.constantFrom(...PROVIDER_IDS);
const key = fc.string({ minLength: 1, maxLength: 12 }).filter((k) => k !== "__proto__");
const perProvider = <T>(value: fc.Arbitrary<T>) =>
  fc.dictionary(providerId, value, { maxKeys: PROVIDER_IDS.length });
const selectedVoice = fc.record({ providerId, voiceId: fc.string({ minLength: 1 }) });
const finite = fc.double({ noNaN: true, noDefaultInfinity: true });

const settingsV1: fc.Arbitrary<SettingsV1> = fc.record(
  {
    schemaVersion: fc.constant(1 as const),
    credentials: perProvider(fc.dictionary(key, fc.string())),
    credentialsValid: perProvider(fc.boolean()),
    enabledProviders: perProvider(fc.boolean()),
    selectedVoice: fc.option(selectedVoice, { nil: null }),
    voicesByLanguage: fc.dictionary(key, selectedVoice),
    favorites: fc.array(fc.string()),
    model: fc.string(),
    style: fc.string(),
    speed: finite,
    pitch: finite,
    volumeGainDb: finite,
    readAloudEncoding: fc.string(),
    downloadEncoding: fc.string(),
    language: fc.string(),
    theme: fc.constantFrom("light", "dark", "system"),
    uiLanguage: fc.constantFrom("auto", ...EXTENSION_LOCALE_IDS),
  },
  { requiredKeys: [...V1_REQUIRED_KEYS] },
);

describe("registry", () => {
  it("covers exactly the versions 0..SETTINGS_VERSION-1, ascending", () => {
    expect(MIGRATIONS.map((step) => step.from)).toEqual(
      Array.from({ length: SETTINGS_VERSION }, (_, i) => i),
    );
  });

  it("ships one fixture per schema version ever written", () => {
    expect(fixtures.map((f) => f.version).sort((a, b) => a - b)).toEqual(
      Array.from({ length: SETTINGS_VERSION }, (_, i) => i + 1),
    );
  });
});

describe("dueMigrations", () => {
  const step = (from: number, description: string): SettingsMigration => ({
    from,
    description,
    up: (raw) => raw,
  });
  const registry = [step(0, "zero"), step(1, "one-a"), step(1, "one-b"), step(2, "two")];

  it.each([
    [0, 3, ["zero", "one-a", "one-b", "two"]],
    [1, 3, ["one-a", "one-b", "two"]],
    [1, 2, ["one-a", "one-b"]],
    [2, 2, []],
    [3, 1, []],
  ])("selects [%i, %i) in registry order", (from, to, expected) => {
    expect(dueMigrations(from, to, registry).map((s) => s.description)).toEqual(expected);
  });
});

describe("peekSchemaVersion", () => {
  it.each([
    [{ schemaVersion: 3 }, 3],
    [{ schemaVersion: 1 }, 1],
    [{}, 1],
    [{ schemaVersion: "2" }, 1],
    [{ schemaVersion: 0 }, 1],
    [{ schemaVersion: 1.5 }, 1],
    [null, 1],
    ["garbage", 1],
  ])("%j reads as v%i", (raw, expected) => {
    expect(peekSchemaVersion(raw)).toBe(expected);
  });
});

describe("upgradeSettingsBlob", () => {
  it("returns the same reference when the blob is already current", () => {
    const blob = { schemaVersion: SETTINGS_VERSION, speed: 2 };
    expect(upgradeSettingsBlob(blob)).toBe(blob);
  });

  it("treats a blob without a version stamp as v1 and upgrades it to current", () => {
    const upgraded = upgradeSettingsBlob({ speed: 2 });
    expect(SettingsSchema.parse(upgraded)).toMatchObject({
      schemaVersion: SETTINGS_VERSION,
      speed: 2,
    });
  });

  it("refuses a blob from a newer build", () => {
    let caught: unknown;
    try {
      upgradeSettingsBlob({ schemaVersion: SETTINGS_VERSION + 1 });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SettingsNewerError);
    expect((caught as SettingsNewerError).storedVersion).toBe(SETTINGS_VERSION + 1);
  });

  it.each(fixtures.map((f) => [f.file, f] as const))(
    "%s chains to exactly current.json, strict-parsing",
    (_file, fixture) => {
      const upgraded = upgradeSettingsBlob(fixtureBlob(fixture.text));
      expect(SettingsSchema.parse(upgraded)).toEqual(CURRENT);
      expect(peekSchemaVersion(upgraded)).toBe(SETTINGS_VERSION);
    },
  );

  it.each(fixtures.map((f) => [f.file, f] as const))(
    "%s imports through parseImport as current.json",
    (_f, fixture) => {
      const result = parseImport(fixture.text);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.droppedFields).toEqual([]);
      expect(result.settings).toEqual(CURRENT);
    },
  );
});

describe("every step is idempotent on its own output", () => {
  it.each(MIGRATIONS.map((step) => [step.from, step] as const))(
    "step from v%i on its fixture",
    (_from, step) => {
      // Step 0 converts the flat keys; every other step converts fixture v<from>.
      const input: unknown =
        step.from === 0
          ? { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1", speed: "1.5" }
          : fixtureBlob(fixtures.find((f) => f.version === step.from)?.text ?? "");
      const once = step.up(input);
      expect(peekSchemaVersion(once)).toBe(step.from + 1);
      expect(step.up(once)).toEqual(once);
    },
  );

  it("holds for arbitrary v1 blobs, and the chain output strict-parses", () => {
    fc.assert(
      fc.property(settingsV1, (blob) => {
        for (const step of MIGRATIONS) {
          const once = step.up(blob);
          expect(step.up(once)).toEqual(once);
        }
        const upgraded = upgradeSettingsBlob(blob);
        expect(SettingsSchema.parse(upgraded)).toMatchObject({
          schemaVersion: SETTINGS_VERSION,
          // Values that exist in every version travel through the chain intact.
          credentials: blob.credentials,
          favorites: blob.favorites,
          speed: blob.speed,
          language: blob.language,
        });
      }),
      { numRuns: 200 },
    );
  });
});
