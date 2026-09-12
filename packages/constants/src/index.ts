// Cross-app identity constants, written down ONCE and shared by the extension (apps/extension) and the
// website (apps/web). Pure constants and URL builders only: nothing here may import browser APIs, so
// node/bun scripts can import it too.

/** Both stores derive the listing title from the manifest name, so renaming this renames the listings. */
export const EXTENSION_NAME = "Cloud Speech";

/** The two original fork listings. README.md's store badge carries a manual copy of the install-listing
 *  ID (enforced by scripts/verify-zips.mjs). */
export const POLLY_ID = "kdcbeehimalgmeoeajnflggejlemclnn"; // originally "Polly for Chrome"
export const AZURE_ID = "dkkdafmbplibmfajcdlfpicngpnkaloc"; // "Azure Speech for Chrome"

/** The unified "Cloud Speech" listing IS the original Polly listing: the store takes the title from the
 *  manifest name, so publishing renamed it in place and its users kept their install. Any nonempty
 *  value flips chromeListing to "published", which exposes the website's install links and wakes the
 *  banner and settings handoff on LEGACY_IDS. */
// The annotation is load-bearing: without it the const gets the literal type of the ID and
// `UNIFIED_ID === ""` below turns into a ts(2367) error.
export const UNIFIED_ID: string = POLLY_ID;

/** Listings whose installs get the "move to Cloud Speech" banner and answer the settings handoff. Must
 *  never include UNIFIED_ID, or the unified install would nag itself and export settings to itself. */
export const LEGACY_IDS = [AZURE_ID];

/** Empty until the Firefox listing is published; any nonempty value flips firefoxListing to "published".
 *    extension  -> shows its review button on Firefox (src/lib/listing.ts)
 *    website    -> shows the "Add to Firefox" link (src/lib/site.ts) */
// Load-bearing annotation; see UNIFIED_ID.
export const FIREFOX_ADDON_SLUG: string = "";

export function chromeStoreUrl(id: string): string {
  return `https://chromewebstore.google.com/detail/${id}`;
}

export function chromeReviewUrl(id: string): string {
  return `${chromeStoreUrl(id)}/reviews`;
}

/** A listing that exists or is still to be created; a pending one has no URLs, so no empty href can
 *  leak into a page or a button. `id` is the CWS listing ID or the AMO slug. */
export type StoreListing =
  | {
      readonly status: "published";
      readonly id: string;
      readonly url: string;
      readonly reviewUrl: string;
    }
  | { readonly status: "pending" };

export const chromeListing: StoreListing =
  UNIFIED_ID === ""
    ? { status: "pending" }
    : {
        status: "published",
        id: UNIFIED_ID,
        url: chromeStoreUrl(UNIFIED_ID),
        reviewUrl: chromeReviewUrl(UNIFIED_ID),
      };

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
/** GitHub Pages base path: the repo name, and the fallback for the Astro `base` (apps/web/src/lib/pages-tier.ts). */
export const SITE_BASE = "/cloud-speech/";
export const SITE_URL = `${SITE_ORIGIN}${SITE_BASE}`;

/** Astro's `server.port`; the extension's dev launch opens the site here. */
export const DEV_WEB_PORT = 5173;
export const DEV_SITE_URL = `http://localhost:${DEV_WEB_PORT}${SITE_BASE}`;

export const GITHUB_REPO_URL = "https://github.com/vivswan/cloud-speech";
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_ISSUES_URL}/new`;

// --- Site locales -----------------------------------------------------------

/** The shipped languages; English is the default (unprefixed URL tree, first entry).
 *    extensionId  the locale YAML file name and the uiLanguage setting
 *    prefix       the website's mirrored page tree
 *    label        the endonym, deliberately NOT translated: every reader must recognize their own
 *                 language whatever language the page or popup is in
 *    storeLocale  the Chrome Web Store's code, and the directory the store screenshots rendered in that
 *                 language are published under (the renderer gives Chromium the same tag as its UI
 *                 language) */
export const SITE_LOCALES = [
  {
    extensionId: "en",
    code: "en",
    prefix: "",
    htmlLang: "en",
    hreflang: "en",
    storeLocale: "en",
    label: "English",
  },
  {
    extensionId: "hi",
    code: "hi",
    prefix: "hi/",
    htmlLang: "hi",
    hreflang: "hi",
    storeLocale: "hi",
    label: "हिन्दी",
  },
  {
    extensionId: "zh_CN",
    code: "zh-cn",
    prefix: "zh-cn/",
    htmlLang: "zh-Hans-CN",
    hreflang: "zh-Hans",
    storeLocale: "zh-CN",
    label: "简体中文",
  },
  {
    extensionId: "zh_TW",
    code: "zh-tw",
    prefix: "zh-tw/",
    htmlLang: "zh-Hant-TW",
    hreflang: "zh-Hant",
    storeLocale: "zh-TW",
    label: "繁體中文",
  },
] as const;

export type SiteLocaleInfo = (typeof SITE_LOCALES)[number];
export type ExtensionLocaleId = SiteLocaleInfo["extensionId"];
export type SiteLocaleCode = SiteLocaleInfo["code"];
export type StoreLocale = SiteLocaleInfo["storeLocale"];

/** Typed as the literal union so Zod enums can derive from the table (zod's `const`-generic z.enum keeps
 *  the literals through a spread). */
export const EXTENSION_LOCALE_IDS: readonly ExtensionLocaleId[] = /* @__PURE__ */ SITE_LOCALES.map(
  (locale) => locale.extensionId,
);

/** Shared by the extension's resolveUiLocale and the website's first-visit detect script (via
 *  define:vars), so the patterns are regex SOURCE strings that survive serialization into the inline
 *  script; match against a lowercased tag. First match wins: bare "zh" means Simplified by Chrome's own
 *  locale convention, so the Traditional rule must run first. */
export const LOCALE_TAG_RULES: readonly { pattern: string; locale: SiteLocaleCode }[] = [
  { pattern: "^zh-(hant|tw|hk|mo)", locale: "zh-tw" },
  { pattern: "^zh(-|$)", locale: "zh-cn" },
  { pattern: "^hi(-|$)", locale: "hi" },
  { pattern: "^en(-|$)", locale: "en" },
];

export function matchSiteLocale(tag: string): SiteLocaleCode | null {
  const lower = tag.toLowerCase();
  const rule = LOCALE_TAG_RULES.find((r) => new RegExp(r.pattern).test(lower));
  return rule ? rule.locale : null;
}

// --- Keyboard shortcuts -----------------------------------------------------

/** The extension's manifest builds `suggested_key` from these; the website and README show their
 *  shortcutDisplay() renderings (scripts/check-sync.mts pins the README). */
export const SHORTCUTS = {
  readAloud: { default: "Ctrl+Shift+S", mac: "Command+Shift+S" },
  download: { default: "Ctrl+Shift+E", mac: "Command+Shift+E" },
} as const;

export type ShortcutBinding = { readonly default: string; readonly mac: string };

/** Bindings that diverge beyond the modifier show both, so neither OS's binding is silently dropped.
 *    "Ctrl+Shift+S" + "Command+Shift+S"  -> "Ctrl/Cmd+Shift+S"
 *    "Ctrl+K" + "Command+Shift+K"        -> "Ctrl+K / Command+Shift+K" */
export function shortcutDisplay(binding: ShortcutBinding): string {
  const rest = binding.default.replace(/^Ctrl\+/, "");
  return binding.mac === `Command+${rest}`
    ? `Ctrl/Cmd+${rest}`
    : `${binding.default} / ${binding.mac}`;
}

// --- Install sources --------------------------------------------------------

/** Sent by the extension's Feedback view to the GitHub issue form. Values must match the
 *  .github/ISSUE_TEMPLATE/bug_report.yml dropdown options byte-for-byte or GitHub silently drops the
 *  prefill (a vitest enforces the coupling, like PROVIDER_NAMES). */
export const INSTALL_SOURCES = {
  chrome: "Chrome Web Store",
  firefox: "Firefox Add-ons",
  source: "Built from source",
} as const;

// --- Provider roster --------------------------------------------------------

/** In display order. Adding a provider: extend this list, add the provider module and locale strings in
 *  the extension, and a setup/<id> page in apps/web (a vitest asserts the pieces stay in sync). */
export const PROVIDER_IDS = ["polly", "azure", "google", "openai", "custom"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Canonical ENGLISH names for where localization is wrong or impossible: the website, docs, and the
 *  GitHub issue-form prefill (values must match .github/ISSUE_TEMPLATE/bug_report.yml options
 *  verbatim). The extension UI localizes names via its locale files instead. */
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  polly: "Amazon Polly",
  azure: "Azure Speech",
  google: "Google Cloud TTS",
  openai: "OpenAI",
  custom: "OpenAI-compatible",
};

// --- Page background pair ---------------------------------------------------

/** Shared by the website's theme-color meta and pre-paint script (apps/web/src/scripts/theme.ts) and the
 *  extension popup's pre-CSS-paint background. packages/ui-tokens/tokens.css and popup/index.html
 *  cannot import TS, so scripts/check-sync.mts pins their literals to these values. */
export const PAGE_BG_LIGHT = "#fafaf9";
export const PAGE_BG_DARK = "#1c1917";

/** The extension's badges/dots (TtsProvider `color`) and the website's `--color-<id>` @theme tokens in
 *  styles.css; Tailwind needs the tokens as literal CSS, so a vitest pins them to these values instead
 *  of generating them. */
export const PROVIDER_COLORS: Record<ProviderId, string> = {
  polly: "#FF9900",
  azure: "#0078D4",
  google: "#DB4437",
  openai: "#10A37F",
  custom: "#64748B",
};
