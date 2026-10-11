import { SITE_LOCALES, type SiteLocaleCode, type SiteLocaleInfo } from "@cloud-speech/constants";

/** Written by the nav switcher (src/inline/site.ts) and Base.astro's first-visit auto-detect; any non-empty
 *  stored value suppresses the auto-redirect. */
export const PREFERRED_LOCALE_STORAGE_KEY = "preferred-locale";

/** The unprefixed locale (astro.config.mts routes it that way), the x-default alternate, and where
 *  first-visit detection starts from. */
export const DEFAULT_LOCALE: SiteLocaleInfo = SITE_LOCALES[0];

export function localeInfo(code: string | undefined): SiteLocaleInfo {
  return SITE_LOCALES.find((locale) => locale.code === code) ?? DEFAULT_LOCALE;
}

/** `base` is the site base the pathname carries (import.meta.env.BASE_URL on a page); a bare route tree
 *  passes "/". */
export function stripLocale(
  pathname: string,
  base: string,
): { locale: SiteLocaleCode; pagePath: string } {
  let path = pathname.startsWith(base) ? pathname.slice(base.length) : pathname;
  path = path.replace(/^\//, "");
  if (path && !path.endsWith("/")) path += "/";

  for (const locale of SITE_LOCALES) {
    if (locale.prefix && path.startsWith(locale.prefix)) {
      return { locale: locale.code, pagePath: path.slice(locale.prefix.length) };
    }
  }
  return { locale: DEFAULT_LOCALE.code, pagePath: path };
}
