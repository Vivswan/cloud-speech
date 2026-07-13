// ---------------------------------------------------------------------------
// Cross-app identity constants — the ONE place they are written down: store
// listings, extension names, site/repo URLs, and the provider roster shared
// by the extension (apps/extension) and the website (apps/web). Pure
// constants and URL builders only: nothing here may import browser APIs, so
// it stays usable from every context (including node/bun scripts).
// ---------------------------------------------------------------------------

/** Manifest/store display name — identical on every browser now that the
 *  extension is no longer Chrome-only. Both stores derive the listing title
 *  from the manifest name. */
export const EXTENSION_NAME = "Cloud Speech";

/** The unified "Cloud Speech" listing.
 *  TODO: Fill in once the unified listing is created in the CWS dashboard
 *  (a draft upload is enough to reserve the ID) — while empty, the
 *  extension's migration banner and settings handoff stay dormant, and the
 *  website's install links render empty. */
export const UNIFIED_ID = "";

/** The two original fork listings, kept updated in place with the same zip.
 *  README.md's store badge carries a manual copy of the install-listing ID —
 *  enforced by scripts/verify-zips.mjs. */
export const POLLY_ID = "kdcbeehimalgmeoeajnflggejlemclnn"; // Polly for Chrome
export const AZURE_ID = "dkkdafmbplibmfajcdlfpicngpnkaloc"; // Azure Speech for Chrome

export const LEGACY_IDS = [POLLY_ID, AZURE_ID];

/** The AMO listing slug.
 *  TODO: Fill in once the Firefox listing is published — while empty, the
 *  extension hides its review button on Firefox and the website hides the
 *  "Add to Firefox" link. */
export const FIREFOX_ADDON_SLUG = "";

/** Store page for a Chrome listing ID. */
export function chromeStoreUrl(id: string): string {
  return `https://chromewebstore.google.com/detail/${id}`;
}

/** Review form for a Chrome listing ID. */
export function chromeReviewUrl(id: string): string {
  return `${chromeStoreUrl(id)}/reviews`;
}

/** Install page for new users, or "" while the unified listing doesn't exist
 *  yet — the website deploys together with the extension release, so the ID
 *  is always filled in by the time a page ships. */
export const chromeWebStoreUrl = UNIFIED_ID !== "" ? chromeStoreUrl(UNIFIED_ID) : "";

/** AMO listing page, or "" while the listing doesn't exist yet. */
export const firefoxAddonUrl =
  FIREFOX_ADDON_SLUG !== ""
    ? `https://addons.mozilla.org/firefox/addon/${FIREFOX_ADDON_SLUG}/`
    : "";

/** AMO review form, or "" while the listing doesn't exist yet. */
export const firefoxReviewUrl =
  FIREFOX_ADDON_SLUG !== ""
    ? `https://addons.mozilla.org/firefox/addon/${FIREFOX_ADDON_SLUG}/reviews/`
    : "";

// --- Website + repo ---------------------------------------------------------

export const SITE_ORIGIN = "https://vivswan.github.io";
/** GitHub Pages base path (also the Astro `base` and the repo name). */
export const SITE_BASE = "/cloud-speech/";
/** Production website URL (trailing slash included). */
export const SITE_URL = `${SITE_ORIGIN}${SITE_BASE}`;

/** apps/web dev-server port (Astro `server.port`; the extension's dev launch
 *  opens the site here). */
export const DEV_WEB_PORT = 5173;
export const DEV_SITE_URL = `http://localhost:${DEV_WEB_PORT}${SITE_BASE}`;

export const GITHUB_REPO_URL = "https://github.com/vivswan/cloud-speech";
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_ISSUES_URL}/new`;

// --- Provider roster --------------------------------------------------------

/** Every TTS provider id, in display order. The extension derives its
 *  ProviderId type and Zod enums from this; the website derives its guide
 *  cards. Adding a provider: extend this list, add the provider module +
 *  locale strings in the extension, and a setup/<id> page in apps/web
 *  (a vitest asserts the pieces stay in sync). */
export const PROVIDER_IDS = ["polly", "azure", "google", "openai", "custom"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Canonical ENGLISH display names — used where localization is wrong or
 *  impossible: the website, GitHub issue-form prefills (values must match
 *  .github/ISSUE_TEMPLATE/bug_report.yml options verbatim), and docs. The
 *  extension UI localizes names via its locale files instead. */
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  polly: "Amazon Polly",
  azure: "Azure Speech",
  google: "Google Cloud TTS",
  openai: "OpenAI",
  custom: "OpenAI-compatible",
};
