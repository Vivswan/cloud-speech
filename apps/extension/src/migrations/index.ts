import { browser } from "#imports";
import { exclusiveSettingsWrite, SETTINGS_VERSION, salvageSettings } from "@/lib/storage";
import { FLAT_KEYS, fromFlatKeys, hasFlatKeys } from "./000000";

// ---------------------------------------------------------------------------
// The ONLY place backwards-compatibility code lives. The settings blob
// carries its own `schemaVersion`; every step here upgrades one version.
// We own versioning rather than using @wxt-dev/storage's `migrations`
// option because that runs once at defineItem time outside our write lock,
// never re-migrates a blob synced later from another device, and answers a
// blob newer than the code with a raw pass-through after a console error.
// Files are named for the version they migrate AWAY from, zero-padded to six
// digits (`000000.ts` = unversioned fork flat keys -> v1).
// ---------------------------------------------------------------------------

export interface SettingsMigration {
  /** 0 = unversioned fork flat keys, 1 = schema v1, ... */
  from: number;
  description: string;
  /** PURE and idempotent on its own output: returns the `from + 1` shape with
   *  `schemaVersion` stamped. */
  up(raw: unknown): unknown;
  /** Optional one-off for LOCAL companions (caches, stale metadata). */
  atStartup?(): Promise<void>;
}

/** Ascending by `from`, contiguous 0..SETTINGS_VERSION-1 (unit-tested). */
export const MIGRATIONS: readonly SettingsMigration[] = [fromFlatKeys];

/** The steps whose `from` falls in the half-open range [from, to), in
 *  registry order. Pure. */
export function dueMigrations(
  from: number,
  to: number,
  registry: readonly SettingsMigration[] = MIGRATIONS,
): SettingsMigration[] {
  return registry.filter((step) => step.from >= from && step.from < to);
}

/** The blob's own version; a missing or malformed field means v1 (the only
 *  version ever written without one). */
export function peekSchemaVersion(raw: unknown): number {
  if (!raw || typeof raw !== "object") return 1;
  const version = (raw as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === "number" && Number.isInteger(version) && version >= 1 ? version : 1;
}

/** A stored blob was written by a NEWER build than this one. */
export class SettingsNewerError extends Error {
  constructor(public readonly storedVersion: number) {
    super(
      `Settings were saved by a newer version (schema v${storedVersion} > v${SETTINGS_VERSION})`,
    );
    this.name = "SettingsNewerError";
  }
}

/** Bring a blob of any known version up to SETTINGS_VERSION. Unchanged
 *  reference on the hot path (already current); throws SettingsNewerError. */
export function upgradeSettingsBlob(raw: unknown): unknown {
  const from = peekSchemaVersion(raw);
  if (from === SETTINGS_VERSION) return raw;
  if (from > SETTINGS_VERSION) throw new SettingsNewerError(from);
  return dueMigrations(Math.max(from, 1), SETTINGS_VERSION).reduce(
    (blob, step) => step.up(blob),
    raw,
  );
}

/**
 * Startup work: convert the forks' flat sync keys (step 0) under the settings
 * write lock, then run every registered `atStartup`. Best-effort: a failure
 * is logged and the stored data stays untouched; startup never aborts here.
 * Writes the new object FIRST, then removes only the known flat keys (never
 * `storage.sync.clear()`).
 */
export async function runStartupMigrations(): Promise<void> {
  try {
    await exclusiveSettingsWrite(async (write) => {
      const raw = await browser.storage.sync.get(null);
      // The object already exists (or this is a fresh install): nothing to convert.
      if (raw.settings !== undefined || !hasFlatKeys(raw)) return false;
      await write(salvageSettings(fromFlatKeys.up(raw)));
      await browser.storage.sync.remove([...FLAT_KEYS]);
      console.log("Converted fork settings to the settings object");
      return true;
    });
  } catch (error) {
    console.error("Converting fork settings failed; keeping the flat keys intact", error);
  }
  for (const step of MIGRATIONS) {
    if (!step.atStartup) continue;
    try {
      await step.atStartup();
    } catch (error) {
      console.warn(`Startup step for schema v${step.from} failed`, error);
    }
  }
}
