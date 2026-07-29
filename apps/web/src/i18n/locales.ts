import { SITE_LOCALES, type SiteLocaleCode, type SiteLocaleInfo } from "@cloud-speech/constants";

// Locale metadata + path helpers for the localized site. The roster itself
// (codes, URL prefixes, lang/hreflang, endonym labels) lives in the shared
// @cloud-speech/constants table; this module adds the site's URL helpers.

export type SiteLocale = SiteLocaleCode;

export type LocaleInfo = SiteLocaleInfo;

export const LOCALES: readonly LocaleInfo[] = SITE_LOCALES;

const DEFAULT_LOCALE: LocaleInfo = SITE_LOCALES[0];

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

/** Base-absolute URL of `pagePath` under a locale, with no relative-depth math. */
export function localeUrl(code: SiteLocale, pagePath: string): string {
  return `${import.meta.env.BASE_URL}${localeInfo(code).prefix}${pagePath}`;
}
