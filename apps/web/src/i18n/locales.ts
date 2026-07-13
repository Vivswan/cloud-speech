// Locale metadata + path helpers for the localized site. The extension's
// resolveUiLocale (apps/extension/src/lib/i18n-runtime.ts) and Base.astro's
// first-visit detect script implement the same browser-tag mapping — keep the
// three in sync.

export type SiteLocale = "en" | "hi" | "zh-cn" | "zh-tw";

export interface LocaleInfo {
  code: SiteLocale;
  /** URL prefix inside the base path — "" for the default locale. */
  prefix: string;
  /** <html lang> value. */
  htmlLang: string;
  /** hreflang for the alternate links (script subtag, not region). */
  hreflang: string;
  /** Endonym — deliberately NOT translated: every reader must recognize
   *  their own language whatever language the page is in. */
  label: string;
}

export const LOCALES: LocaleInfo[] = [
  { code: "en", prefix: "", htmlLang: "en", hreflang: "en", label: "English" },
  { code: "hi", prefix: "hi/", htmlLang: "hi", hreflang: "hi", label: "हिन्दी" },
  {
    code: "zh-cn",
    prefix: "zh-cn/",
    htmlLang: "zh-Hans-CN",
    hreflang: "zh-Hans",
    label: "简体中文",
  },
  {
    code: "zh-tw",
    prefix: "zh-tw/",
    htmlLang: "zh-Hant-TW",
    hreflang: "zh-Hant",
    label: "繁體中文",
  },
];

const DEFAULT_LOCALE = LOCALES[0] as LocaleInfo;

export function localeInfo(code: string | undefined): LocaleInfo {
  return LOCALES.find((locale) => locale.code === code) ?? DEFAULT_LOCALE;
}

/**
 * Split a base-prefixed pathname into its locale and the locale-relative page
 * path ("" for the home page, "setup/polly/" for a guide). The page path is
 * normalized to a trailing slash so it can be joined onto any locale prefix.
 */
export function stripLocale(pathname: string): { locale: SiteLocale; pagePath: string } {
  const base = import.meta.env.BASE_URL;
  let path = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  path = path.replace(/^\//, "");
  if (path && !path.endsWith("/")) path += "/";

  for (const locale of LOCALES) {
    if (locale.prefix && path.startsWith(locale.prefix)) {
      return { locale: locale.code, pagePath: path.slice(locale.prefix.length) };
    }
  }
  return { locale: "en", pagePath: path };
}

/** Base-absolute URL of `pagePath` under a locale — no relative-depth math. */
export function localeUrl(code: SiteLocale, pagePath: string): string {
  return `${import.meta.env.BASE_URL}${localeInfo(code).prefix}${pagePath}`;
}
