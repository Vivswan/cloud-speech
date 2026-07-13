import { X } from "lucide-react";
import { useEffect, useState } from "react";
import { i18n } from "#i18n";
import { browser } from "#imports";
import { isLegacyInstall, unifiedStoreUrl } from "@/lib/listing";
import {
  type MigrationBannerState,
  migrationBannerItem,
  updateMigrationBanner,
} from "@/lib/storage";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Shown only when this install runs under one of the LEGACY Chrome listing
 *  IDs (the artifact is identical across listings — see lib/listing.ts):
 *  nudges the user toward the unified listing, and flips to a "settings
 *  transferred" note once the unified install confirms its import. */
export function MigrationBanner() {
  const [state, setState] = useState<MigrationBannerState | null>(null);
  const storeUrl = unifiedStoreUrl();

  useEffect(() => {
    if (!isLegacyInstall() || !storeUrl) return;
    // Watch first: the import confirmation can land while the popup is open —
    // the banner must flip to "transferred" live, not on the next open. The
    // initial read is only a fallback and must never overwrite a state the
    // watcher already delivered (it can resolve later), nor land after
    // unmount.
    let sawWatchEvent = false;
    let disposed = false;
    const unwatch = migrationBannerItem.watch((next) => {
      sawWatchEvent = true;
      setState(next);
    });
    void migrationBannerItem.getValue().then((initial) => {
      if (!disposed && !sawWatchEvent) setState(initial);
    });
    return () => {
      disposed = true;
      unwatch();
    };
  }, [storeUrl]);

  if (!state || !storeUrl) return null;
  // Transferred + dismissed → done with this banner forever (the handoff
  // resets dismissedAt when the import lands, so a dismissal seen here
  // happened AFTER the "settings transferred" confirmation was shown).
  if (state.imported && state.dismissedAt !== null) return null;
  // Not transferred yet → dismissals snooze it for a week, not forever.
  if (!state.imported && state.dismissedAt !== null && Date.now() - state.dismissedAt < WEEK_MS) {
    return null;
  }

  const dismiss = () => {
    setState((previous) => (previous ? { ...previous, dismissedAt: Date.now() } : previous));
    // Locked read-modify-write — a concurrent `imported: true` from the
    // background must never be clobbered by this dismissal.
    void updateMigrationBanner({ dismissedAt: Date.now() });
  };

  return (
    <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
      <div className="min-w-0 flex-1">
        {state.imported ? (
          <span>{i18n.t("migration.transferred")}</span>
        ) : (
          <>
            <span>{i18n.t("migration.moved")}</span>{" "}
            <button
              type="button"
              className="cursor-pointer font-semibold underline underline-offset-2 hover:text-amber-700"
              onClick={() => void browser.tabs.create({ url: storeUrl })}
            >
              {i18n.t("migration.install")}
            </button>
          </>
        )}
      </div>
      <button
        type="button"
        title={i18n.t("common.dismiss")}
        className="shrink-0 cursor-pointer rounded p-0.5 text-amber-500 hover:bg-amber-100 hover:text-amber-700"
        onClick={dismiss}
      >
        <X size={13} />
      </button>
    </div>
  );
}
