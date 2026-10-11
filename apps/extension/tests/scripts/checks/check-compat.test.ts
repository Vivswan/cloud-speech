import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  compatToken,
  exemptIdentifiers,
  scanTree,
} from "../../../../../scripts/checks/check-compat.mts";

const SOURCES = "apps/extension/src";
const MIGRATIONS = `${SOURCES}/migrations`;

const MIGRATION_SOURCES: Record<string, string> = {
  [`${MIGRATIONS}/ladder.ts`]: [
    'import { legacyEpoch } from "./epochs.json";',
    'import { readLegacyBlob } from "./legacy";',
    "export interface SettingsMigration {\n  readonly to: number;\n}",
    "export type LegacyShape = Record<string, unknown>;",
    "export const MIGRATIONS: readonly SettingsMigration[] = [];",
    "export async function runStartupMigrations(): Promise<void> {\n  readLegacyBlob(legacyEpoch);\n}",
    "export class SettingsNewerError extends Error {}",
    "function migrateOne(): void {}",
  ].join("\n"),
  [`${MIGRATIONS}/legacy.tsx`]: [
    "export enum LegacyKind {\n  Blob = 0,\n}",
    "export let legacyReads = 0;",
    "export var legacyCount = 0;",
    "export function readLegacyBlob(epoch: number) {}",
    "export function* migrateAll() {}",
  ].join("\n"),
};

describe("compatibility-code placement scan", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-compat-"));
    for (const [path, source] of Object.entries(MIGRATION_SOURCES)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("exempts every name the migrations folder exports and nothing else", () => {
    expect([...exemptIdentifiers(root)].sort()).toEqual([
      "LegacyKind",
      "LegacyShape",
      "MIGRATIONS",
      "SettingsMigration",
      "SettingsNewerError",
      "legacyCount",
      "legacyReads",
      "migrateAll",
      "readLegacyBlob",
      "runStartupMigrations",
    ]);
  });

  it.each([
    ["// legacy", "legacy"],
    ['import x from "@/migrations-old";', "migrations"],
    ["const legacySettings = value;", "legacy"],
    ["function migrateOldShape() {}", "migrate"],
    ["function migratesOldSettings() {}", "migrates"],
    ["const migratingSettings = raw;", "migrating"],
    ["const settings_legacy = 1;", "legacy"],
    ["const parseXMLMigration = value;", "Migration"],
    ["const XMLLegacySettings = value;", "Legacy"],
    ["const BACKWARDS_COMPAT = true;", "BACKWARDS COMPAT"],
    ['import { runStartupMigrations } from "@/migrations"; // the migration runner', "migration"],
    ["const MIGRATIONS_DONE = 1;", "MIGRATIONS"],
    ["migrateOne();", "migrate"],
    ["const since = legacyEpoch;", "legacy"],
  ])("flags %s", (line, token) => {
    expect(compatToken(line, exemptIdentifiers(root))).toBe(token);
  });

  it.each([
    'import { runStartupMigrations, SettingsNewerError } from "@/migrations";',
    'import { SETTINGS_VERSION } from "@/migrations/version";',
    "await runStartupMigrations();",
    "const ladder: SettingsMigration[] = [...MIGRATIONS];",
    "for (const step of migrateAll()) step(LegacyKind.Blob, legacyCount);",
    "// OpenAI-compatible endpoints",
    "const oldest = versions[0];",
  ])("passes %s", (line) => {
    expect(compatToken(line, exemptIdentifiers(root))).toBeNull();
  });

  it("scans every source outside the folder and reports each hit as path:line: token", () => {
    const consumers: Record<string, string> = {
      [`${SOURCES}/entrypoints/background.ts`]: [
        'import { runStartupMigrations } from "@/migrations";',
        "await runStartupMigrations();",
        "const legacyKeys = Object.keys(raw);",
      ].join("\n"),
      [`${SOURCES}/lib/settings/storage.tsx`]: "const settings = parse(raw);\n",
      [`${SOURCES}/lib/settings/notes.md`]: "the old shape\n",
    };
    for (const [path, source] of Object.entries(consumers)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), source);
    }

    expect(scanTree(root)).toEqual({
      inspected: 2,
      findings: [`${SOURCES}/entrypoints/background.ts:3: legacy`],
    });
  });
});
