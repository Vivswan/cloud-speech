import {
  chromeListing,
  chromeReviewUrl,
  chromeStoreUrl,
  firefoxListing,
} from "@cloud-speech/constants";
import { browser } from "#imports";

// One build is published to both Chrome Web Store listing IDs (in
// packages/constants): Cloud Speech, and the Azure listing kept so its
// installs can hand their settings over. Behaviour that differs per listing
// branches at runtime on browser.runtime.id, so the shipped artifact stays
// byte-identical across listings.

export function isUnifiedInstall(): boolean {
  if (import.meta.env.FIREFOX) return false;
  return chromeListing.status === "published" && browser.runtime.id === chromeListing.id;
}

export function unifiedStoreUrl(): string | null {
  return chromeListing.status === "published" ? chromeListing.url : null;
}

/** Only store installs carry an update_url; a review link for an unpacked
 *  dev build would 404. */
function isStoreInstall(): boolean {
  return Boolean(browser.runtime.getManifest().update_url);
}

/** Where an update of THIS copy lives: an Azure-listing install sent to the
 *  unified listing would get a second installation, not an update. An
 *  unpacked build has no listing of its own and gets the unified page. */
export function installedStoreUrl(): string | null {
  if (import.meta.env.FIREFOX) {
    return firefoxListing.status === "published" ? firefoxListing.url : null;
  }
  return isStoreInstall() ? chromeStoreUrl(browser.runtime.id) : unifiedStoreUrl();
}

export function reviewUrl(): string | null {
  if (import.meta.env.FIREFOX) {
    return firefoxListing.status === "published" ? firefoxListing.reviewUrl : null;
  }
  if (!isStoreInstall()) return null;
  return chromeReviewUrl(browser.runtime.id);
}
