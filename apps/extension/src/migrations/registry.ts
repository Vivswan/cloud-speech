// ---------------------------------------------------------------------------
// The ladder is the folder listing: `00000N.ts` is step N, the one that moves a
// blob away from schema version N, and the current version is the file count.
// Nothing on this module's import path may import lib/storage.ts, which reads
// SETTINGS_VERSION while it loads.
// ---------------------------------------------------------------------------

export interface SettingsMigration {
  description: string;
  /** Pure and idempotent on its own output: returns the next version's shape with `schemaVersion` stamped. */
  up(raw: unknown): unknown;
  /** One-off for LOCAL companions (caches, stale metadata). The runner holds the settings write
   *  lock while it runs, so the step itself never imports lib/storage.ts: that file reads
   *  SETTINGS_VERSION while loading, and the ladder must be complete by then. */
  atStartup?(): Promise<void>;
}

function isStep(value: unknown): value is SettingsMigration {
  return (
    typeof value === "object" && value !== null && "up" in value && typeof value.up === "function"
  );
}

/** Throws at load rather than skipping: a gap, a stray name, or a file without the `step` export
 *  would otherwise shift every later step by one and renumber users' stored data. */
export function ladderFrom(modules: Readonly<Record<string, unknown>>): SettingsMigration[] {
  return Object.keys(modules)
    .sort()
    .map((file, index) => {
      const expected = `./${String(index).padStart(6, "0")}.ts`;
      if (file !== expected) {
        throw new Error(`Migration step file ${file} breaks the ladder; expected ${expected}`);
      }
      const module = modules[file];
      const step =
        typeof module === "object" && module !== null && "step" in module ? module.step : undefined;
      if (!isStep(step)) throw new Error(`Migration step file ${file} does not export a step`);
      return step;
    });
}

export const MIGRATIONS: readonly SettingsMigration[] = ladderFrom(
  import.meta.glob("./0*.ts", { eager: true }),
);

export const SETTINGS_VERSION = MIGRATIONS.length;
