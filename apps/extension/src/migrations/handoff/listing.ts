import { LEGACY_IDS } from "@cloud-speech/constants";
import { browser } from "#imports";

/** Never true on Firefox or for unpacked dev installs; those have their own ids. */
export function isLegacyInstall(): boolean {
  if (import.meta.env.FIREFOX) return false;
  return LEGACY_IDS.includes(browser.runtime.id);
}
