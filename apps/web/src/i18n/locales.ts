import { SITE_LOCALES, type SiteLocaleCode, type SiteLocaleInfo } from "@cloud-speech/constants";

/** Written by the nav switcher (src/scripts/site.ts) and Base.astro's first-visit auto-detect; any non-empty
 *  stored value suppresses the auto-redirect. */
export const PREFERRED_LOCALE_STORAGE_KEY = "preferred-locale";

const DEFAULT_LOCALE: SiteLocaleInfo = SITE_LOCALES[0];

export function localeInfo(code: string | undefined): SiteLocaleInfo {
  return SITE_LOCALES.find((locale) => locale.code === code) ?? DEFAULT_LOCALE;
}

export function stripLocale(pathname: string): { locale: SiteLocaleCode; pagePath: string } {
  const base = import.meta.env.BASE_URL;
  let path = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  path = path.replace(/^\//, "");
  if (path && !path.endsWith("/")) path += "/";

  for (const locale of SITE_LOCALES) {
    if (locale.prefix && path.startsWith(locale.prefix)) {
      return { locale: locale.code, pagePath: path.slice(locale.prefix.length) };
    }
  }
  return { locale: "en", pagePath: path };
}

/** Base-absolute, so no relative-depth math per page. */
export function localeUrl(code: SiteLocaleCode, pagePath: string): string {
  return `${import.meta.env.BASE_URL}${localeInfo(code).prefix}${pagePath}`;
}
