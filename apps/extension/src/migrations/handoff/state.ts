import { storage } from "#imports";
import { enqueueWrite } from "@/lib/storage";

// Handoff state for the fork listings (Chrome only): the popup banner on the
// fork side, the import-done flag on the unified side. Storage keys keep the
// names the 2.0.0 builds wrote so existing installs keep their state.

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

/** Unified-listing side: fork settings were imported (or deliberately skipped
 *  because this install was already configured); never ask again. */
export const handoffImportDoneItem = storage.defineItem<boolean>("local:legacyImportDone", {
  fallback: false,
});
