import { flatKeysToSettingsObject } from "./flat-keys-to-settings-object";
import { perProviderCredentials } from "./per-provider-credentials";

// ---------------------------------------------------------------------------
// Retiring the bottom rung means dropping it here and raising FIRST_VERSION.
// Nothing on this module's import path may import lib/storage.ts, which
// reads SETTINGS_VERSION while it loads.
// ---------------------------------------------------------------------------

export interface SettingsMigration {
  description: string;
  /** Pure and idempotent on its own output: returns the next version's shape with `schemaVersion` stamped. */
  up(raw: unknown): unknown;
  /** One-off for LOCAL companions (caches, stale metadata). The runner holds the settings write
   *  lock while it runs, so the step itself never imports lib/storage.ts. */
  atStartup?(): Promise<void>;
}

export interface Ladder {
  /** The schema version the first step moves away from. */
  firstVersion: number;
  steps: readonly SettingsMigration[];
}

export const FIRST_VERSION = 0;

export const MIGRATIONS = [flatKeysToSettingsObject, perProviderCredentials] as const;

export const SETTINGS_VERSION = FIRST_VERSION + MIGRATIONS.length;
