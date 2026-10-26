import { DEV_SITE_URL, SITE_LOCALES, SITE_URL } from "@cloud-speech/constants";
import type { UiLocale } from "@/lib/text/i18n-runtime";

// Dev builds open the local Vite server, so guide edits live-reload; apps/web pins its port with strictPort.
const GUIDE_BASE = import.meta.env.DEV ? DEV_SITE_URL : SITE_URL;

// A Map because the extension's locale ids (zh_CN) trip the object-property naming rule.
const SITE_LOCALE_PREFIX = new Map<UiLocale, string>(
  SITE_LOCALES.map((locale) => [locale.extensionId, locale.prefix] as const),
);

/** guideUrl("setup/polly", "hi") -> .../cloud-speech/hi/setup/polly/ */
export function guideUrl(path: string, locale: UiLocale = "en"): string {
  return `${GUIDE_BASE}${SITE_LOCALE_PREFIX.get(locale) ?? ""}${path}/`;
}

export function homepageUrl(locale: UiLocale = "en"): string {
  return `${GUIDE_BASE}${SITE_LOCALE_PREFIX.get(locale) ?? ""}`;
}
