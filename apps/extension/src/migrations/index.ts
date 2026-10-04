import { browser } from "#imports";
import { logError, logWarning } from "@/lib/log";
import { enqueueWrite, salvageSettings } from "@/lib/storage";
import { FLAT_KEYS, step as fromFlatKeys, hasFlatKeys } from "./000000";
import { MIGRATIONS, SETTINGS_VERSION, type SettingsMigration } from "./registry";
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

/** The steps that carry a blob from schema `from` to `to`: a step's index is the version it
 *  moves away from. */
export function dueMigrations(from: number, to: number): readonly SettingsMigration[] {
  return MIGRATIONS.slice(from, to);
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
    logError("Converting fork settings failed; keeping the flat keys intact", error);
  }
  for (const [index, step] of MIGRATIONS.entries()) {
    const { atStartup } = step;
    if (!atStartup) continue;
    try {
      await enqueueWrite(() => atStartup.call(step));
    } catch (error) {
      logWarning(`Startup step for schema v${index} failed`, error);
    }
  }
}
