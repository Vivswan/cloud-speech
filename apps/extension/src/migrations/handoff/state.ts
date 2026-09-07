import { storage } from "#imports";
import { enqueueWrite } from "@/lib/storage";
import type { ProviderId } from "@/providers/types";

// Handoff state (Chrome only): the popup banner on the fork side, the
// per-fork import records on the unified side. The banner key keeps the name
// the 2.0.0 builds wrote so existing installs keep their state.

/** Fork-listing side. Only used when running under one of the fork IDs. */
export interface HandoffBannerState {
  /** Last dismissal timestamp; the banner re-shows after a week. */
  dismissedAt: number | null;
  /** The unified extension confirmed it imported this install's settings. */
  imported: boolean;
}

export const handoffBannerItem = storage.defineItem<HandoffBannerState>("local:migrationBanner", {
  fallback: { dismissedAt: null, imported: false },
});

/** ALL banner writes go through here: the popup's dismissal and the
 *  background's imported-flag write are separate contexts doing
 *  read-modify-write on the same object. Unserialized, a dismissal could
 *  resurrect stale `imported: false` over a concurrent import confirmation. */
export function updateHandoffBanner(patch: Partial<HandoffBannerState>): Promise<void> {
  return enqueueWrite(async () => {
    const current = await handoffBannerItem.getValue();
    await handoffBannerItem.setValue({ ...current, ...patch });
  });
}

/** Fork side: the unified install confirmed the import. The dismissal resets
 *  so a banner snoozed BEFORE the import still shows its one "settings
 *  transferred" confirmation. A repeated confirmation (the unified install
 *  missed the first answer and sends again next start) changes nothing, so a
 *  dismissal made AFTER the transfer stays. */
export function markHandoffImported(): Promise<void> {
  return enqueueWrite(async () => {
    const current = await handoffBannerItem.getValue();
    if (current.imported) return;
    await handoffBannerItem.setValue({ imported: true, dismissedAt: null });
  });
}

/** Unified-listing side: what was taken from one fork install. */
export interface HandoffImportRecord {
  /** ISO 8601 */
  importedAt: string;
  /** Providers whose credentials came from that install (empty when it had
   *  nothing this install lacked). */
  providers: ProviderId[];
  /** The fork answered ok to settingsImported, so its banner and retirement
   *  are in place. Until then every start tells it again (never re-imports). */
  acknowledged: boolean;
}

/** Unified-listing side, keyed by fork extension id. A fork present here is
 *  never asked for its settings again; one absent is retried on every
 *  background start. */
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
