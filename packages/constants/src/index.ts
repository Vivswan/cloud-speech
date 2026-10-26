// Cross-app identity constants, written down ONCE and shared by the extension (apps/extension) and the
// website (apps/web). Pure constants and URL builders only: nothing here may import browser APIs, so
// node/bun scripts can import it too.

/** Both stores derive the listing title from the manifest name, so renaming this renames the listings. */
export const EXTENSION_NAME = "Cloud Speech";

/** Typed `string` so `=== ""` below compiles; README.md's badge copies this ID by hand (verify-zips.mts checks). */
export const CHROME_LISTING_ID: string = "kdcbeehimalgmeoeajnflggejlemclnn";

/** Empty until the Firefox listing exists; a slug shows the website's install link and the extension's review button. */
const FIREFOX_ADDON_SLUG: string = "";

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

/** Pending hides the website's Chrome install links and the store link an unpacked build shows. */
export const chromeListing: StoreListing =
  CHROME_LISTING_ID === ""
    ? { status: "pending" }
    : {
        status: "published",
        id: CHROME_LISTING_ID,
        url: chromeStoreUrl(CHROME_LISTING_ID),
        reviewUrl: chromeReviewUrl(CHROME_LISTING_ID),
      };

/** Pending hides the website's Firefox install link and the extension's Firefox install and review links. */
export const firefoxListing: StoreListing =
  FIREFOX_ADDON_SLUG === ""
    ? { status: "pending" }
    : {
        status: "published",
        id: FIREFOX_ADDON_SLUG,
        url: `https://addons.mozilla.org/firefox/addon/${FIREFOX_ADDON_SLUG}/`,
        reviewUrl: `https://addons.mozilla.org/firefox/addon/${FIREFOX_ADDON_SLUG}/reviews/`,
      };

/** The GitHub Pages origin, and the fallback when PAGES_ORIGIN is unset (apps/web/src/lib/pages-tier.ts). */
export const SITE_ORIGIN = "https://vivswan.github.io";

/** GitHub Pages base path: the repo name, and the fallback for the Astro `base` (apps/web/src/lib/pages-tier.ts). */
export const SITE_BASE = "/cloud-speech/";

/** The published root with its trailing slash; check-sync.mts pins the copies in README.md and the two issue-template files. */
export const SITE_URL = `${SITE_ORIGIN}${SITE_BASE}`;

/** Astro's `server.port`; the extension's dev launch opens the site here. */
export const DEV_WEB_PORT = 5173;

/** The local site at the same base path, which the extension's dev launch opens instead of SITE_URL. */
export const DEV_SITE_URL = `http://localhost:${DEV_WEB_PORT}${SITE_BASE}`;

/** The repository; the website, the extension's sidebar, and the store screenshots' published path all derive from it. */
export const GITHUB_REPO_URL = "https://github.com/vivswan/cloud-speech";

/** The issue list, where the website's troubleshooting pages and the extension's Feedback view send readers. */
export const GITHUB_ISSUES_URL = `${GITHUB_REPO_URL}/issues`;

/** The issue form; the extension's Feedback view prefills it through the query string. */
export const GITHUB_NEW_ISSUE_URL = `${GITHUB_ISSUES_URL}/new`;

/** The shipped languages in display order; English is first and the default, on the unprefixed URL tree. */
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

/** One shipped language. What the field names do not say:
 *    extensionId  the locale YAML file name and the uiLanguage setting
 *    prefix       the website's mirrored page tree
 *    label        the endonym, deliberately NOT translated: every reader must recognize their own language
 *    storeLocale  the Chrome Web Store's code, and the directory the screenshots rendered in that language publish
 *                 under (the renderer gives Chromium the same tag as its UI language) */
export type SiteLocaleInfo = (typeof SITE_LOCALES)[number];
export type ExtensionLocaleId = SiteLocaleInfo["extensionId"];
export type SiteLocaleCode = SiteLocaleInfo["code"];
export type StoreLocale = SiteLocaleInfo["storeLocale"];

/** Typed as the literal union, so z.enum(["auto", ...EXTENSION_LOCALE_IDS]) keeps the literals. */
export const EXTENSION_LOCALE_IDS: readonly ExtensionLocaleId[] = /* @__PURE__ */ SITE_LOCALES.map(
  (locale) => locale.extensionId,
);

/** Regex SOURCE strings, not RegExps: apps/web/src/inline/locale.ts serializes them into the inline script as JSON. */
export const LOCALE_TAG_RULES: readonly { pattern: string; locale: SiteLocaleCode }[] = [
  // Against a lowercased tag, first match wins: bare "zh" is Simplified by Chrome's convention, so Traditional runs first.
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

/** The manifest builds `suggested_key` from these; scripts/checks/check-sync.mts pins the README's copy. */
export const SHORTCUTS = {
  readAloud: { default: "Ctrl+Shift+S", mac: "Command+Shift+S" },
  download: { default: "Ctrl+Shift+E", mac: "Command+Shift+E" },
} as const;

type ShortcutBinding = { readonly default: string; readonly mac: string };

/** Bindings that diverge beyond the modifier show both, so neither OS's binding is silently dropped.
 *    "Ctrl+Shift+S" + "Command+Shift+S"  -> "Ctrl/Cmd+Shift+S"
 *    "Ctrl+K" + "Command+Shift+K"        -> "Ctrl+K / Command+Shift+K" */
export function shortcutDisplay(binding: ShortcutBinding): string {
  const rest = binding.default.replace(/^Ctrl\+/, "");
  return binding.mac === `Command+${rest}`
    ? `Ctrl/Cmd+${rest}`
    : `${binding.default} / ${binding.mac}`;
}

/** In display order; apps/extension/tests/lib/roster-sync.test.ts names every place a new id must also appear. */
export const PROVIDER_IDS = ["polly", "azure", "google", "openai", "custom"] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** English, for the website, docs, and the GitHub issue form; .github/ISSUE_TEMPLATE/bug_report.yml lists these verbatim. */
export const PROVIDER_NAMES: Record<ProviderId, string> = {
  polly: "Amazon Polly",
  azure: "Azure Speech",
  google: "Google Cloud TTS",
  openai: "OpenAI",
  custom: "OpenAI-compatible",
};

/** Painted before CSS loads, so tokens.css and popup/index.html hold literal copies, pinned by check-sync.mts. */
export const PAGE_BG_LIGHT = "#fafaf9";

/** The dark counterpart, with the same literal copies pinned. */
export const PAGE_BG_DARK = "#1c1917";

/** styles.css repeats these as literal `--color-<id>` tokens, since Tailwind needs literal CSS; a vitest pins the copies. */
export const PROVIDER_COLORS: Record<ProviderId, string> = {
  polly: "#FF9900",
  azure: "#0078D4",
  google: "#DB4437",
  openai: "#10A37F",
  custom: "#64748B",
};
