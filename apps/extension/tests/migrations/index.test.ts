import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseImport } from "@/lib/settings-transfer";
import { type Settings, SettingsSchema } from "@/lib/storage";
import { dueMigrations, SettingsNewerError, upgradeSettingsBlob } from "@/migrations";
import { step as fromFlatKeys } from "@/migrations/000000";
import { step as toPerProvider } from "@/migrations/000001";
import {
  ladderFrom,
  MIGRATIONS,
  SETTINGS_VERSION,
  type SettingsMigration,
} from "@/migrations/registry";
import { peekSchemaVersion } from "@/migrations/version";
import { settingsV1 } from "../helpers/settings-v1";

const FIXTURES_DIR = resolve(__dirname, "fixtures");

/** Fixtures v<N>.json all describe the SAME user's settings, one per schema version ever shipped;
 *  current.json is those settings in the current shape, so every fixture must upgrade to exactly it. */
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

describe("registry", () => {
  it("ships one fixture per schema version ever written", () => {
    expect(fixtures.map((f) => f.version).sort((a, b) => a - b)).toEqual(
      Array.from({ length: SETTINGS_VERSION }, (_, i) => i + 1),
    );
  });
});

describe("ladderFrom refuses a folder that would renumber users' stored data", () => {
  const step = (description: string): SettingsMigration => ({ description, up: (raw) => raw });
  const zero = step("zero");
  const one = step("one");

  it("orders by file name, not by object key", () => {
    const ladder = ladderFrom({ "./000001.ts": { step: one }, "./000000.ts": { step: zero } });
    expect(ladder[0]).toBe(zero);
    expect(ladder[1]).toBe(one);
  });

  it.each([
    ["a gap", { "./000000.ts": { step: zero }, "./000002.ts": { step: one } }, "./000002.ts"],
    [
      "a second file for one version",
      {
        "./000000.ts": { step: zero },
        "./000001.ts": { step: one },
        "./000001-b.ts": { step: one },
      },
      "./000001-b.ts",
    ],
    [
      "a name outside the ladder",
      { "./000000.ts": { step: zero }, "./01.ts": { step: one } },
      "./01.ts",
    ],
    ["a file without the step export", { "./000000.ts": { fromFlatKeys: zero } }, "./000000.ts"],
    ["a step export that is not a step", { "./000000.ts": { step: "zero" } }, "./000000.ts"],
  ])("throws at load naming the file: %s", (_case, modules, file) => {
    expect(() => ladderFrom(modules)).toThrow(file);
  });
});

describe("dueMigrations", () => {
  it.each([
    [0, 2, [fromFlatKeys, toPerProvider]],
    [1, 2, [toPerProvider]],
    [2, 2, []],
    [3, 1, []],
  ])("selects the steps at indices [%i, %i)", (from, to, expected) => {
    expect(dueMigrations(from, to)).toEqual(expected);
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
  it.each(MIGRATIONS.map((step, index) => [index, step] as const))(
    "step %i on its fixture",
    (index, step) => {
      // Step 0 converts the flat keys; every other step converts fixture v<index>.
      const input: unknown =
        index === 0
          ? { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1", speed: "1.5" }
          : fixtureBlob(fixtures.find((f) => f.version === index)?.text ?? "");
      const once = step.up(input);
      expect(peekSchemaVersion(once)).toBe(index + 1);
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
          favorites: blob.favorites,
          voicesByLanguage: blob.voicesByLanguage,
          speed: blob.speed,
          language: blob.language,
        });
      }),
      { numRuns: 200 },
    );
  });
});
