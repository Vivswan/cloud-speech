import { storage } from "#imports";
import { enqueueWrite } from "@/lib/storage";
import type { ProviderId } from "@/providers/types";

// Handoff state (Chrome only). The banner key keeps the name the 2.0.0 builds wrote so existing
// installs keep their state.

/** Fork side. */
export interface HandoffBannerState {
  /** A dismissal snoozes an unimported banner for a week and ends an imported one for good (Banner.tsx). */
  dismissedAt: number | null;
  /** Set once the unified install confirmed its import. */
  imported: boolean;
}

export const handoffBannerItem = storage.defineItem<HandoffBannerState>("local:migrationBanner", {
  fallback: { dismissedAt: null, imported: false },
});

/** Every banner write goes through the lock: the popup's dismissal and the background's imported
 *  flag are separate contexts doing read-modify-write on one object, and an unserialized dismissal
 *  could resurrect a stale `imported: false`. */
export function updateHandoffBanner(patch: Partial<HandoffBannerState>): Promise<void> {
  return enqueueWrite(async () => {
    const current = await handoffBannerItem.getValue();
    await handoffBannerItem.setValue({ ...current, ...patch });
  });
}

/** The dismissal resets so a banner snoozed before the import still shows its one "settings
 *  transferred" confirmation. A repeated confirmation changes nothing, so a dismissal made after
 *  the transfer stays. */
export function markHandoffImported(): Promise<void> {
  return enqueueWrite(async () => {
    const current = await handoffBannerItem.getValue();
    if (current.imported) return;
    await handoffBannerItem.setValue({ imported: true, dismissedAt: null });
  });
}

/** Unified side: what was taken from one fork install. */
export interface HandoffImportRecord {
  /** ISO 8601 */
  importedAt: string;
  /** Empty when the fork had nothing this install lacked. */
  providers: ProviderId[];
  /** The fork answered ok to settingsImported. Until then every start tells it again, never re-imports. */
  acknowledged: boolean;
}

/** Keyed by fork extension id. A fork present here is never asked for its settings again. */
export const handoffImportsItem = storage.defineItem<Record<string, HandoffImportRecord>>(
  "local:handoffImports",
  { fallback: {} },
);

export async function recordHandoffImport(
  forkId: string,
  record: HandoffImportRecord,
): Promise<void> {
  const imports = await handoffImportsItem.getValue();
  await handoffImportsItem.setValue({ ...imports, [forkId]: record });
}
