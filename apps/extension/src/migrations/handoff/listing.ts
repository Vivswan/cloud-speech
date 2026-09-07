import { LEGACY_IDS } from "@cloud-speech/constants";
import { browser } from "#imports";

/** Running under one of the fork Chrome listing IDs (never true on Firefox
 *  or for unpacked dev installs; those have their own IDs). */
export function isLegacyInstall(): boolean {
  if (import.meta.env.FIREFOX) return false;
  return LEGACY_IDS.includes(browser.runtime.id);
}
