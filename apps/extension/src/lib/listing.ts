import {
  chromeReviewUrl,
  chromeStoreUrl,
  firefoxReviewUrl,
  LEGACY_IDS,
  UNIFIED_ID,
} from "@cloud-speech/constants";
import { browser } from "#imports";

// ---------------------------------------------------------------------------
// Runtime listing helpers. The identities themselves live in the shared
// @cloud-speech/constants package (single source of truth, also consumed by
// the website); this module adds everything that needs browser APIs.
//
// ONE build is published to all three Chrome Web Store listing IDs; behavior
// that differs per listing (the legacy-listing migration banner, settings
// handoff) branches at RUNTIME on browser.runtime.id so the shipped artifact
// stays byte-identical across listings.
// ---------------------------------------------------------------------------

export { LEGACY_IDS, UNIFIED_ID };

/** Running under one of the legacy Chrome listing IDs (never true on Firefox
 *  or for unpacked dev installs; those have their own IDs). */
export function isLegacyInstall(): boolean {
  if (import.meta.env.FIREFOX) return false;
  return LEGACY_IDS.includes(browser.runtime.id);
}

/** Running under the unified Chrome listing ID. */
export function isUnifiedInstall(): boolean {
  if (import.meta.env.FIREFOX) return false;
  return UNIFIED_ID !== "" && browser.runtime.id === UNIFIED_ID;
}

/** Store page of the unified listing (migration banner target). */
export function unifiedStoreUrl(): string | null {
  return UNIFIED_ID !== "" ? chromeStoreUrl(UNIFIED_ID) : null;
}

/** Only store installs carry an update_url; a review link for an unpacked
 *  dev build would 404. */
function isStoreInstall(): boolean {
  return Boolean(browser.runtime.getManifest().update_url);
}

/** Review page for the listing the user actually installed from, or null
 *  when there is nothing sensible to link to. */
export function reviewUrl(): string | null {
  if (import.meta.env.FIREFOX) {
    return firefoxReviewUrl !== "" ? firefoxReviewUrl : null;
  }
  if (!isStoreInstall()) return null;
  // runtime.id is whichever listing this install came from (unified or
  // legacy), so the user always lands on the right review form.
  return chromeReviewUrl(browser.runtime.id);
}
