import { browser } from "#imports";
import { logError, logInfo, logWarning } from "@/lib/log";
import { enqueueWrite, salvageSettings } from "@/lib/storage";
import { FLAT_KEYS, flatKeysToSettingsObject, hasFlatKeys } from "./flat-keys-to-settings-object";
import {
  FIRST_VERSION,
  type Ladder,
  MIGRATIONS,
  SETTINGS_VERSION,
  type SettingsMigration,
} from "./ladder";
import { peekSchemaVersion } from "./version";

// ---------------------------------------------------------------------------
// The ONLY place backwards-compatibility code lives; every step upgrades one
// schema version, in the order ./ladder.ts lists them. @wxt-dev/storage's own
// `migrations` option was rejected:
//   runs once at defineItem time   -> outside the settings write lock
//   never re-runs                  -> a blob synced later from another device stays old
//   blob newer than the code       -> raw pass-through after a console error
// ---------------------------------------------------------------------------

const LADDER: Ladder = { firstVersion: FIRST_VERSION, steps: MIGRATIONS };

/** The steps that carry a blob from schema `from` to `to`. */
export function dueMigrations(
  from: number,
  to: number,
  ladder: Ladder = LADDER,
): readonly SettingsMigration[] {
  const start = Math.max(from, ladder.firstVersion) - ladder.firstVersion;
  const end = Math.max(to - ladder.firstVersion, 0);
  return ladder.steps.slice(start, end);
}

export class SettingsNewerError extends Error {
  constructor(
    public readonly storedVersion: number,
    current: number = SETTINGS_VERSION,
  ) {
    super(`Settings were saved by a newer version (schema v${storedVersion} > v${current})`);
    this.name = "SettingsNewerError";
  }
}

export function upgradeSettingsBlob(raw: unknown, ladder: Ladder = LADDER): unknown {
  const from = peekSchemaVersion(raw);
  const current = ladder.firstVersion + ladder.steps.length;
  if (from === current) return raw;
  if (from > current) throw new SettingsNewerError(from, current);
  // Handed on untouched: the storage layer's salvage path keeps the known fields of any unknown shape.
  if (from < ladder.firstVersion) return raw;
  return dueMigrations(from, current, ladder).reduce((blob, step) => step.up(blob), raw);
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
      await browser.storage.sync.set({
        settings: salvageSettings(flatKeysToSettingsObject.up(raw)),
      });
      await browser.storage.sync.remove([...FLAT_KEYS]);
      logInfo("Converted fork settings to the settings object");
    });
  } catch (error) {
    logError("Converting fork settings failed; keeping the flat keys intact", error);
  }
  for (const step of MIGRATIONS) {
    const { atStartup } = step;
    if (!atStartup) continue;
    try {
      await enqueueWrite(() => atStartup.call(step));
    } catch (error) {
      logWarning(`Startup step "${step.description}" failed`, error);
    }
  }
}
