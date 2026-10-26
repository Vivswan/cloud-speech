import { LOCALE_TAG_RULES, matchSiteLocale, type SiteLocaleCode } from "@cloud-speech/constants";
import { DEFAULT_LOCALE, PREFERRED_LOCALE_STORAGE_KEY } from "../i18n/locales";
import { assertSafeInlineScript, scriptLiteral } from "./inline-script";

// The first-visit locale detect, inlined by Base.astro the same way as theme.ts (Function.prototype.toString),
// so initLocale stays closure-free; scripts/check-theme-init.mts runs the emitted copy.

export interface LocalePage {
  /** The tree the page was built in (Astro.currentLocale), not the visitor's preference. */
  locale: SiteLocaleCode;

  /** Locale-stripped and base-stripped, as i18n/locales' stripLocale returns it. */
  pagePath: string;

  /** import.meta.env.BASE_URL, trailing slash included, so base + code + "/" is a locale tree's root. */
  base: string;

  /** 404 only: it has no locale variants to redirect to. */
  noRedirect: boolean;
}

/** Default-locale tree only. Storing before navigating makes it one-shot: a stored preference (set here or by
 *  the nav switcher) always wins later. `match` is constants' matchSiteLocale; it and the two values arrive
 *  as parameters because the inlined copy cannot reach their modules. */
function initLocale(
  page: LocalePage,
  storageKey: string,
  defaultLocale: SiteLocaleCode,
  match: typeof matchSiteLocale,
): void {
  if (page.noRedirect || page.locale !== defaultLocale) return;
  try {
    if (localStorage.getItem(storageKey)) return;
    const languages = navigator.languages?.length
      ? navigator.languages
      : [navigator.language || ""];
    for (const language of languages) {
      const pick = match(String(language));
      if (!pick) continue;
      // navigator.languages is ordered by preference: the default locale before any other match means stay.
      if (pick === defaultLocale) return;
      localStorage.setItem(storageKey, pick);
      location.replace(`${page.base}${pick}/${page.pagePath}`);
      return;
    }
  } catch {
    // Storage denied; stay on the default locale.
  }
}

/** matchSiteLocale reads its module's LOCALE_TAG_RULES; the serialized copy finds that name as the
 *  enclosing arrow's parameter instead. */
export function localeInitScript(page: LocalePage): string {
  const args = [
    scriptLiteral(page),
    scriptLiteral(PREFERRED_LOCALE_STORAGE_KEY),
    scriptLiteral(DEFAULT_LOCALE.code),
    matchSiteLocale.toString(),
  ];
  return assertSafeInlineScript(
    `((LOCALE_TAG_RULES) => (${initLocale.toString()})(${args.join(", ")}))(${scriptLiteral(LOCALE_TAG_RULES)});`,
  );
}
