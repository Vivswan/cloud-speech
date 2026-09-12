import { LEGACY_IDS } from "@cloud-speech/constants";
import { browser } from "#imports";
import { handoffBannerItem } from "./state";

export interface RetiredMode {
  isRetired(): boolean;
}

/** Fork side: once the unified install has taken this install's settings, this copy goes quiet so
 *  the user never sees two "Read aloud" menus or has two extensions answer one shortcut. The
 *  manifest's commands cannot be unregistered at runtime, so the background turns their handlers
 *  into no-ops through isRetired().
 *
 *    clearMenus  -> the background's serialized menu removal; one outside that queue is undone by a queued build's pending creates */
export async function initRetiredMode(
  clearMenus: () => Promise<void>,
  legacyIds: readonly string[] = LEGACY_IDS,
): Promise<RetiredMode> {
  let retired = false;
  if (!legacyIds.includes(browser.runtime.id)) return { isRetired: () => retired };

  const retire = async (): Promise<void> => {
    if (retired) return;
    // Flag first: a build already queued behind this removal must see it.
    retired = true;
    await clearMenus();
  };
  // Watch before read: an import landing between the two must not be missed.
  handoffBannerItem.watch((state) => {
    if (state?.imported) retire().catch((e) => console.warn("Retiring the menus failed", e));
  });
  if ((await handoffBannerItem.getValue()).imported) await retire();
  return { isRetired: () => retired };
}
