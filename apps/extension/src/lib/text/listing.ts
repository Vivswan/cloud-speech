import {
  chromeListing,
  chromeReviewUrl,
  chromeStoreUrl,
  firefoxListing,
} from "@cloud-speech/constants";
import { browser } from "#imports";

// The store listings are in packages/constants. Where a copy came from is read
// at runtime from its manifest and browser.runtime.id, so the shipped artifact
// carries no listing-specific code.

/** Only store installs carry an update_url; a review link for an unpacked
 *  dev build would 404. */
function isStoreInstall(): boolean {
  return Boolean(browser.runtime.getManifest().update_url);
}

/** Where an update of THIS copy lives. An unpacked build has no listing of its
 *  own and gets the store page. */
export function installedStoreUrl(): string | null {
  if (import.meta.env.FIREFOX) {
    return firefoxListing.status === "published" ? firefoxListing.url : null;
  }
  if (isStoreInstall()) return chromeStoreUrl(browser.runtime.id);
  return chromeListing.status === "published" ? chromeListing.url : null;
}

export function reviewUrl(): string | null {
  if (import.meta.env.FIREFOX) {
    return firefoxListing.status === "published" ? firefoxListing.reviewUrl : null;
  }
  if (!isStoreInstall()) return null;
  return chromeReviewUrl(browser.runtime.id);
}
