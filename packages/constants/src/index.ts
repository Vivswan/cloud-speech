// ---------------------------------------------------------------------------
// Cross-app identity constants, the ONE place they are written down: store
// listings, extension names, site/repo URLs, and the provider roster shared
// by the extension (apps/extension) and the website (apps/web). Pure
// constants and URL builders only: nothing here may import browser APIs, so
// it stays usable from every context (including node/bun scripts).
// ---------------------------------------------------------------------------

/** Manifest/store display name, identical on every browser now that the
 *  extension is no longer Chrome-only. Both stores derive the listing title
 *  from the manifest name. */
export const EXTENSION_NAME = "Cloud Speech";

/** The unified "Cloud Speech" listing.
 *  TODO: Fill in once the unified listing is PUBLISHED (publicly installable
 *  in the CWS). A reserved-but-unpublished draft ID must NOT go here: any
 *  nonempty value flips chromeListing to "published", which exposes the
 *  website's install links and wakes the extension's migration banner and
 *  settings handoff. While empty, all of those stay dormant. */
// The annotation is load-bearing: without it the const gets the literal type
// "" and filling in the ID turns `UNIFIED_ID === ""` into a ts(2367) error.
export const UNIFIED_ID: string = "";

/** The two original fork listings, kept updated in place with the same zip.
 *  README.md's store badge carries a manual copy of the install-listing ID
 *  (enforced by scripts/verify-zips.mjs). */
export const POLLY_ID = "kdcbeehimalgmeoeajnflggejlemclnn"; // Polly for Chrome
export const AZURE_ID = "dkkdafmbplibmfajcdlfpicngpnkaloc"; // Azure Speech for Chrome

export const LEGACY_IDS = [POLLY_ID, AZURE_ID];

/** The AMO listing slug.
 *  TODO: Fill in once the Firefox listing is published. While empty,
 *  firefoxListing stays "pending": the extension hides its review button on
 *  Firefox and the website hides the "Add to Firefox" link. */
// Load-bearing annotation; see UNIFIED_ID.
export const FIREFOX_ADDON_SLUG: string = "";

/** Store page for a Chrome listing ID. */
export function chromeStoreUrl(id: string): string {
  return `https://chromewebstore.google.com/detail/${id}`;
}

/** Review form for a Chrome listing ID. */
export function chromeReviewUrl(id: string): string {
  return `${chromeStoreUrl(id)}/reviews`;
}

/** A store listing that either exists or is still to be created. Consumers
 *  must narrow on `status` before touching the URLs, so a pending listing
 *  can never leak an empty href into a page or a button. `id` is the CWS
 *  listing ID or the AMO slug. */
export type StoreListing =
  | {
      readonly status: "published";
      readonly id: string;
      readonly url: string;
      readonly reviewUrl: string;
    }
  | { readonly status: "pending" };

/** The unified Chrome Web Store listing new users install from. */
export const chromeListing: StoreListing =
  UNIFIED_ID === ""
    ? { status: "pending" }
    : {
        status: "published",
        id: UNIFIED_ID,
        url: chromeStoreUrl(UNIFIED_ID),
        reviewUrl: chromeReviewUrl(UNIFIED_ID),
      };

/** The addons.mozilla.org listing. */
export const firefoxListing: StoreListing =
  FIREFOX_ADDON_SLUG === ""
    ? { status: "pending" }
    : {
        status: "published",
        id: FIREFOX_ADDON_SLUG,
        url: `https://addons.mozilla.org/firefox/addon/${FIREFOX_ADDON_SLUG}/`,
        reviewUrl: `https://addons.mozilla.org/firefox/addon/${FIREFOX_ADDON_SLUG}/reviews/`,
      };

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

// --- Site locales -----------------------------------------------------------

/** The four shipped languages, shared by the extension (locale files named
 *  `extensionId`, the uiLanguage setting) and the website (mirrored page
 *  trees under `prefix`, `<html lang>`, hreflang alternates). English is the
 *  default: unprefixed URL tree, first entry. `label` is the endonym and
 *  deliberately NOT translated: every reader must recognize their own
 *  language whatever language the page or popup is in. */
export const SITE_LOCALES = [
  { extensionId: "en", code: "en", prefix: "", htmlLang: "en", hreflang: "en", label: "English" },
  { extensionId: "hi", code: "hi", prefix: "hi/", htmlLang: "hi", hreflang: "hi", label: "हिन्दी" },
  {
    extensionId: "zh_CN",
    code: "zh-cn",
    prefix: "zh-cn/",
    htmlLang: "zh-Hans-CN",
    hreflang: "zh-Hans",
    label: "简体中文",
  },
  {
    extensionId: "zh_TW",
    code: "zh-tw",
    prefix: "zh-tw/",
    htmlLang: "zh-Hant-TW",
    hreflang: "zh-Hant",
    label: "繁體中文",
  },
] as const;

export type SiteLocaleInfo = (typeof SITE_LOCALES)[number];
/** Extension locale id, e.g. "zh_CN" (also the locale YAML file names). */
export type ExtensionLocaleId = SiteLocaleInfo["extensionId"];
/** Website locale code, e.g. "zh-cn" (also the URL prefix minus the slash). */
export type SiteLocaleCode = SiteLocaleInfo["code"];

/** The extension ids in table order, typed with their literal union so Zod
 *  enums can derive from the table (zod's `const`-generic z.enum keeps the
 *  literals through a spread). */
export const EXTENSION_LOCALE_IDS: readonly ExtensionLocaleId[] = SITE_LOCALES.map(
  (locale) => locale.extensionId,
);

/** BCP-47 tag rules mapping a browser/OS language onto SITE_LOCALES, shared
 *  by the extension's resolveUiLocale and the website's first-visit detect
 *  script (which receives this data via define:vars). Order matters: first
 *  match wins, and bare "zh" means Simplified by Chrome's own locale
 *  convention, so the Traditional rule must run first. Patterns are regex
 *  SOURCE strings (not RegExp objects) so they survive serialization into
 *  the inline script; match against a lowercased tag. */
export const LOCALE_TAG_RULES: readonly { pattern: string; locale: SiteLocaleCode }[] = [
  { pattern: "^zh-(hant|tw|hk|mo)", locale: "zh-tw" },
  { pattern: "^zh(-|$)", locale: "zh-cn" },
  { pattern: "^hi(-|$)", locale: "hi" },
  { pattern: "^en(-|$)", locale: "en" },
];

/** The site locale a browser language tag belongs to, or null when the
 *  language is not shipped (callers decide the fallback). */
export function matchSiteLocale(tag: string): SiteLocaleCode | null {
  const lower = tag.toLowerCase();
  const rule = LOCALE_TAG_RULES.find((r) => new RegExp(r.pattern).test(lower));
  return rule ? rule.locale : null;
}

// --- Keyboard shortcuts -----------------------------------------------------

/** Suggested manifest key bindings for the two commands. The extension's
 *  manifest builds `suggested_key` from these; the website and README show
 *  their shortcutDisplay() renderings (a check script pins the README). */
export const SHORTCUTS = {
  readAloud: { default: "Ctrl+Shift+S", mac: "Command+Shift+S" },
  download: { default: "Ctrl+Shift+E", mac: "Command+Shift+E" },
} as const;

export type ShortcutBinding = { readonly default: string; readonly mac: string };

/** Cross-OS display rendering of a binding: "Ctrl+Shift+S" + "Command+Shift+S"
 *  collapse to "Ctrl/Cmd+Shift+S"; bindings that diverge beyond the modifier
 *  show both, "default / mac", so neither OS's binding is silently dropped. */
export function shortcutDisplay(binding: ShortcutBinding): string {
  const rest = binding.default.replace(/^Ctrl\+/, "");
  return binding.mac === `Command+${rest}`
    ? `Ctrl/Cmd+${rest}`
    : `${binding.default} / ${binding.mac}`;
}

// --- Install sources --------------------------------------------------------

/** Install-source labels the extension's Feedback view sends to the GitHub
 *  issue form. Values must match the .github/ISSUE_TEMPLATE/bug_report.yml
 *  dropdown options byte-for-byte or GitHub silently drops the prefill
 *  (a vitest enforces the coupling, like PROVIDER_NAMES). */
export const INSTALL_SOURCES = {
  chrome: "Chrome Web Store",
  firefox: "Firefox Add-ons",
  source: "Built from source",
} as const;

// --- Provider roster --------------------------------------------------------

/** Every TTS provider id, in display order. The extension derives its
 *  ProviderId type and Zod enums from this; the website derives its guide
 *  cards. Adding a provider: extend this list, add the provider module +
 *  locale strings in the extension, and a setup/<id> page in apps/web
 *  (a vitest asserts the pieces stay in sync). */
export const PROVIDER_IDS = ["polly", "azure", "google", "openai", "custom"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Canonical ENGLISH display names, used where localization is wrong or
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

/** Brand accent hex per provider: the extension's badges/dots (TtsProvider
 *  `color`) and the website's `--color-<id>` @theme tokens in styles.css
 *  (Tailwind needs the tokens as literal CSS, so a vitest pins them to
 *  these values instead of generating them). */
export const PROVIDER_COLORS: Record<ProviderId, string> = {
  polly: "#FF9900",
  azure: "#0078D4",
  google: "#DB4437",
  openai: "#10A37F",
  custom: "#64748B",
};
