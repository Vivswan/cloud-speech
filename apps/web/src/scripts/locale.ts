import { LOCALE_TAG_RULES, matchSiteLocale, type SiteLocaleCode } from "@cloud-speech/constants";
import { PREFERRED_LOCALE_STORAGE_KEY } from "../i18n/locales";
import { assertSafeInlineScript, scriptLiteral } from "./inline-script";

// The first-visit locale detect, inlined by Base.astro the same way as theme.ts (Function.prototype.toString),
// so initLocale stays closure-free; scripts/check-theme-init.mts runs the emitted copy.

export interface LocalePage {
  locale: SiteLocaleCode;
  /** Locale-stripped and base-stripped, as i18n/locales' stripLocale returns it. */
  pagePath: string;
  base: string;
  /** 404 only: it has no locale variants to redirect to. */
  noRedirect: boolean;
}

/** English tree only. Storing before navigating makes it one-shot: a stored preference (set here or by the
 *  nav switcher) always wins later. `match` is constants' matchSiteLocale, which arrives as a parameter
 *  because the inlined copy cannot reach that module. */
export function initLocale(
  page: LocalePage,
  storageKey: string,
  match: typeof matchSiteLocale,
): void {
  if (page.noRedirect || page.locale !== "en") return;
  try {
    if (localStorage.getItem(storageKey)) return;
    const languages = navigator.languages?.length
      ? navigator.languages
      : [navigator.language || ""];
    for (const language of languages) {
      const pick = match(String(language));
      if (!pick) continue;
      // navigator.languages is ordered by preference: English before any other match means stay.
      if (pick === "en") return;
      localStorage.setItem(storageKey, pick);
      location.replace(`${page.base}${pick}/${page.pagePath}`);
      return;
    }
  } catch {
    // Storage denied; stay on English.
  }
}

/** matchSiteLocale reads its module's LOCALE_TAG_RULES; the serialized copy finds that name as the
 *  enclosing arrow's parameter instead. */
export function localeInitScript(page: LocalePage): string {
  const args = [
    scriptLiteral(page),
    scriptLiteral(PREFERRED_LOCALE_STORAGE_KEY),
    matchSiteLocale.toString(),
  ];
  return assertSafeInlineScript(
    `((LOCALE_TAG_RULES) => (${initLocale.toString()})(${args.join(", ")}))(${scriptLiteral(LOCALE_TAG_RULES)});`,
  );
}
