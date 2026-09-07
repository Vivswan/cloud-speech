import { LEGACY_IDS } from "@cloud-speech/constants";
import { browser } from "#imports";
import { handoffBannerItem } from "./state";

export interface RetiredMode {
  isRetired(): boolean;
}

/** Fork side: once the unified install has taken this install's settings,
 *  this copy goes quiet so the user never sees two "Read aloud" menus or has
 *  two extensions answer one shortcut. Context menus are removed; the
 *  manifest's commands cannot be unregistered at runtime, so the background
 *  turns their handlers into no-ops through isRetired() instead. Watches the
 *  banner state, so an import landing while this background is alive retires
 *  it without a restart. Inert on non-fork installs. */
export async function initRetiredMode(
  legacyIds: readonly string[] = LEGACY_IDS,
): Promise<RetiredMode> {
  let retired = false;
  if (!legacyIds.includes(browser.runtime.id)) return { isRetired: () => retired };

  const retire = async (): Promise<void> => {
    if (retired) return;
    retired = true;
    await browser.contextMenus.removeAll();
  };
  // Watch before read: an import landing between the two must not be missed.
  handoffBannerItem.watch((state) => {
    if (state?.imported) retire().catch((e) => console.warn("Retiring the menus failed", e));
  });
  if ((await handoffBannerItem.getValue()).imported) await retire();
  return { isRetired: () => retired };
}
