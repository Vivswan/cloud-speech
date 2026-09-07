import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { compatToken, exemptIdentifiers, scanTree } from "../../../../scripts/check-compat.mts";

const ROOT = resolve(__dirname, "../../../..");
// The scan reads the exemption list from the folder itself; pin the names
// that carry compatibility vocabulary so widening it is a visible decision.
const exempt = exemptIdentifiers(ROOT);

describe("compatibility-code placement scan", () => {
  it("exempts exactly the folder's exported names that carry the vocabulary", () => {
    const carrying = [...exempt].filter((name) => compatToken(name, new Set()) !== null).sort();
    expect(carrying).toEqual([
      "MIGRATIONS",
      "SettingsMigration",
      "dueMigrations",
      "isLegacyInstall",
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
  ])("flags %s", (line, token) => {
    expect(compatToken(line, exempt)).toBe(token);
  });

  it.each([
    'import { runStartupMigrations, SettingsNewerError } from "@/migrations";',
    'import { HandoffBanner } from "@/migrations/handoff/Banner";',
    "await runStartupMigrations();",
    "// OpenAI-compatible endpoints",
    "const oldest = versions[0];",
  ])("passes %s", (line) => {
    expect(compatToken(line, exempt)).toBeNull();
  });

  it("scans the extension sources and finds the tree clean", () => {
    const { scanned, hits } = scanTree(ROOT);
    expect(hits).toEqual([]);
    expect(scanned).toBeGreaterThan(40);
  });
});
