import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseImport } from "@/lib/settings/settings-transfer";
import { type Settings, SettingsSchema } from "@/lib/settings/storage";
import { dueMigrations, SettingsNewerError, upgradeSettingsBlob } from "@/migrations";
import {
  FIRST_VERSION,
  type Ladder,
  MIGRATIONS,
  SETTINGS_VERSION,
  type SettingsMigration,
} from "@/migrations/ladder";
import { perProviderCredentials } from "@/migrations/per-provider-credentials";
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

function expectLandsOnCurrent(upgraded: unknown): void {
  expect(SettingsSchema.parse(upgraded)).toEqual(CURRENT);
  expect(peekSchemaVersion(upgraded)).toBe(SETTINGS_VERSION);
}

describe("ladder", () => {
  it("ships one fixture per schema version ever written", () => {
    expect(fixtures.map((f) => f.version).sort((a, b) => a - b)).toEqual(
      Array.from({ length: SETTINGS_VERSION }, (_, i) => i + 1),
    );
  });
});

describe("dueMigrations", () => {
  it.each([
    [1, 2, [perProviderCredentials]],
    [2, 2, []],
    [3, 1, []],
  ])("selects the steps for versions [%i, %i) on the shipped ladder", (from, to, expected) => {
    expect(dueMigrations(from, to)).toEqual(expected);
  });

  it("counts positions from the floor, and a range below it selects nothing", () => {
    const step = (description: string): SettingsMigration => ({ description, up: (raw) => raw });
    const ladder: Ladder = {
      firstVersion: 3,
      steps: [step("three to four"), step("four to five")],
    };
    expect(dueMigrations(3, 5, ladder)).toEqual(ladder.steps);
    expect(dueMigrations(4, 5, ladder)).toEqual([ladder.steps[1]]);
    expect(dueMigrations(0, 4, ladder)).toEqual([ladder.steps[0]]);
    // Unclamped, `to - firstVersion` below zero would slice from the end and pick the first step.
    expect(dueMigrations(0, 2, ladder)).toEqual([]);
    expect(dueMigrations(5, 5, ladder)).toEqual([]);
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

  it("names the ladder's own top rung when refusing a newer blob", () => {
    const ladder: Ladder = {
      firstVersion: 2,
      steps: [perProviderCredentials, perProviderCredentials],
    };
    expect(() => upgradeSettingsBlob({ schemaVersion: 5 }, ladder)).toThrow("schema v5 > v4");
  });

  it.each(fixtures.map((f) => [f.file, f] as const))(
    "%s chains to exactly current.json, strict-parsing",
    (_file, fixture) => {
      expectLandsOnCurrent(upgradeSettingsBlob(fixtureBlob(fixture.text)));
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

describe("retiring the bottom rung: the fixture tests guard the floor", () => {
  const v1 = () => fixtureBlob(fixtures.find((f) => f.version === 1)?.text ?? "");

  it("a blob below the floor is handed to salvage untouched, never climbed", () => {
    const never: SettingsMigration = {
      description: "must not run",
      up: () => {
        throw new Error("climbed a blob from below the floor");
      },
    };
    const blob = v1();
    expect(upgradeSettingsBlob(blob, { firstVersion: 2, steps: [never] })).toBe(blob);
  });

  it("dropping the first step and raising the floor lands fixture v1 on current.json", () => {
    expectLandsOnCurrent(
      upgradeSettingsBlob(v1(), { firstVersion: 1, steps: [perProviderCredentials] }),
    );
  });

  it("dropping the first step without raising the floor fails the same landing check", () => {
    const upgraded = upgradeSettingsBlob(v1(), {
      firstVersion: 0,
      steps: [perProviderCredentials],
    });
    expect(() => expectLandsOnCurrent(upgraded)).toThrow();
  });
});

describe("every step is idempotent on its own output", () => {
  it.each(MIGRATIONS.map((step, index) => [FIRST_VERSION + index, step] as const))(
    "the step away from v%i on its fixture",
    (version, step) => {
      // Version 0 is the flat keys; every other version has a fixture blob.
      const input: unknown =
        version === 0
          ? { accessKeyId: "AKIA", secretAccessKey: "s", region: "us-east-1", speed: "1.5" }
          : fixtureBlob(fixtures.find((f) => f.version === version)?.text ?? "");
      const once = step.up(input);
      expect(peekSchemaVersion(once)).toBe(version + 1);
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
