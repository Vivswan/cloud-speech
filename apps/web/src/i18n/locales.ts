import { SITE_LOCALES, type SiteLocaleCode, type SiteLocaleInfo } from "@cloud-speech/constants";

export type SiteLocale = SiteLocaleCode;

/** Written by the nav switcher (src/scripts/site.ts) and Base.astro's first-visit auto-detect; any non-empty
 *  stored value suppresses the auto-redirect. */
export const PREFERRED_LOCALE_STORAGE_KEY = "preferred-locale";

export type LocaleInfo = SiteLocaleInfo;

export const LOCALES: readonly LocaleInfo[] = SITE_LOCALES;

const DEFAULT_LOCALE: LocaleInfo = SITE_LOCALES[0];

export function localeInfo(code: string | undefined): LocaleInfo {
  return LOCALES.find((locale) => locale.code === code) ?? DEFAULT_LOCALE;
}

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

/** Base-absolute, so no relative-depth math per page. */
export function localeUrl(code: SiteLocale, pagePath: string): string {
  return `${import.meta.env.BASE_URL}${localeInfo(code).prefix}${pagePath}`;
}
