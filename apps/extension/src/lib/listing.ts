import {
  chromeListing,
  chromeReviewUrl,
  chromeStoreUrl,
  firefoxListing,
} from "@cloud-speech/constants";
import { browser } from "#imports";

// ---------------------------------------------------------------------------
// Runtime listing helpers. The identities themselves live in the shared
// @cloud-speech/constants package (single source of truth, also consumed by
// the website); this module adds everything that needs browser APIs.
//
// ONE build is published to both Chrome Web Store listing IDs: the Cloud
// Speech listing (the former Polly listing, renamed in place) and the Azure
// listing, kept so its installs can hand their settings over. Behavior that
// differs per listing (that handoff banner and settings export) branches at
// RUNTIME on browser.runtime.id so the shipped artifact stays byte-identical
// across listings.
// ---------------------------------------------------------------------------

/** Running under the unified Chrome listing ID. */
export function isUnifiedInstall(): boolean {
  if (import.meta.env.FIREFOX) return false;
  return chromeListing.status === "published" && browser.runtime.id === chromeListing.id;
}

/** Store page of the unified listing (handoff banner target). */
export function unifiedStoreUrl(): string | null {
  return chromeListing.status === "published" ? chromeListing.url : null;
}

/** Only store installs carry an update_url; a review link for an unpacked
 *  dev build would 404. */
function isStoreInstall(): boolean {
  return Boolean(browser.runtime.getManifest().update_url);
}

/** Store page of the listing this install came from: where an update of THIS
 *  copy lives. An Azure-listing install must not be sent to the unified
 *  listing, which would be a second installation, not an update. An unpacked
 *  build has no listing of its own and gets the unified page; null while
 *  that listing is pending. */
export function installedStoreUrl(): string | null {
  if (import.meta.env.FIREFOX) {
    return firefoxListing.status === "published" ? firefoxListing.url : null;
  }
  return isStoreInstall() ? chromeStoreUrl(browser.runtime.id) : unifiedStoreUrl();
}

/** Review page for the listing the user actually installed from, or null
 *  when there is nothing sensible to link to. */
export function reviewUrl(): string | null {
  if (import.meta.env.FIREFOX) {
    return firefoxListing.status === "published" ? firefoxListing.reviewUrl : null;
  }
  if (!isStoreInstall()) return null;
  // runtime.id is whichever listing this install came from (unified or the
  // Azure listing), so the user always lands on the right review form.
  return chromeReviewUrl(browser.runtime.id);
}
