import { browser } from "#imports";
import { enqueueWrite, SETTINGS_VERSION, salvageSettings } from "@/lib/storage";
import { FLAT_KEYS, fromFlatKeys, hasFlatKeys } from "./000000";
import { toPerProvider } from "./000001";
import { peekSchemaVersion } from "./version";

// ---------------------------------------------------------------------------
// The ONLY place backwards-compatibility code lives; every step upgrades one
// schema version, and files are named for the version they migrate AWAY from,
// zero-padded to six digits. @wxt-dev/storage's own `migrations` option was
// rejected:
//   runs once at defineItem time   -> outside the settings write lock
//   never re-runs                  -> a blob synced later from another device stays old
//   blob newer than the code       -> raw pass-through after a console error
// ---------------------------------------------------------------------------

export interface SettingsMigration {
  /** 0 = unversioned fork flat keys, 1 = schema v1, ... */
  from: number;
  description: string;
  /** Pure and idempotent on its own output: returns the `from + 1` shape with `schemaVersion` stamped. */
  up(raw: unknown): unknown;
  /** One-off for LOCAL companions (caches, stale metadata). */
  atStartup?(): Promise<void>;
}

/** Ascending by `from`, contiguous 0..SETTINGS_VERSION-1 (unit-tested). */
export const MIGRATIONS: readonly SettingsMigration[] = [fromFlatKeys, toPerProvider];

export function dueMigrations(
  from: number,
  to: number,
  registry: readonly SettingsMigration[] = MIGRATIONS,
): SettingsMigration[] {
  return registry.filter((step) => step.from >= from && step.from < to);
}

export class SettingsNewerError extends Error {
  constructor(public readonly storedVersion: number) {
    super(
      `Settings were saved by a newer version (schema v${storedVersion} > v${SETTINGS_VERSION})`,
    );
    this.name = "SettingsNewerError";
  }
}

export function upgradeSettingsBlob(raw: unknown): unknown {
  const from = peekSchemaVersion(raw);
  if (from === SETTINGS_VERSION) return raw;
  if (from > SETTINGS_VERSION) throw new SettingsNewerError(from);
  return dueMigrations(Math.max(from, 1), SETTINGS_VERSION).reduce(
    (blob, step) => step.up(blob),
    raw,
  );
}

/** Best-effort: a failure is logged and startup continues. The object always lands in the SYNC
 *  area next to the flat keys, which may have synced from a device still on a fork build while
 *  this one keeps its settings in local storage.
 *
 *    set() fails               -> flat keys untouched, converted again next start
 *    set() ok, remove() fails  -> the object stands; the next start sees `settings` and skips */
export async function runStartupMigrations(): Promise<void> {
  try {
    await enqueueWrite(async () => {
      const raw = await browser.storage.sync.get(null);
      if (raw.settings !== undefined || !hasFlatKeys(raw)) return;
      await browser.storage.sync.set({ settings: salvageSettings(fromFlatKeys.up(raw)) });
      await browser.storage.sync.remove([...FLAT_KEYS]);
      console.log("Converted fork settings to the settings object");
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
