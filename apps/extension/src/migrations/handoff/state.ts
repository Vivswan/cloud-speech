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

/** Unified-listing side: what was taken from one fork install. */
export interface HandoffImportRecord {
  /** ISO 8601 */
  importedAt: string;
  /** Providers whose credentials came from that install (empty when it had
   *  nothing this install lacked). */
  providers: ProviderId[];
}

/** Unified-listing side, keyed by fork extension id. A fork present here is
 *  never asked again; one absent is retried on every background start. */
export const handoffImportsItem = storage.defineItem<Record<string, HandoffImportRecord>>(
  "local:handoffImports",
  { fallback: {} },
);

export async function recordHandoffImport(forkId: string, providers: ProviderId[]): Promise<void> {
  const imports = await handoffImportsItem.getValue();
  await handoffImportsItem.setValue({
    ...imports,
    [forkId]: { importedAt: new Date().toISOString(), providers },
  });
}
