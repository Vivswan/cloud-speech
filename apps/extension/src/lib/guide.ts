import { DEV_SITE_URL, SITE_URL } from "@cloud-speech/constants";
import type { UiLocale } from "@/lib/i18n-runtime";

// Base URL of the setup-guide website (single-sourced in the shared
// @cloud-speech/constants package).
// Dev builds point at the local Vite server (`bun run dev` starts both apps;
// apps/web pins the port with strictPort) so guide edits are live-reloaded.
// Production builds point at the published GitHub Pages site.
const GUIDE_BASE = import.meta.env.DEV ? DEV_SITE_URL : SITE_URL;

// URL prefixes of the website's mirrored locale trees (apps/web
// src/pages/<prefix>). English is the unprefixed default tree. A Map because
// the extension's locale ids (zh_CN) trip the object-property naming rule.
const SITE_LOCALE_PREFIX = new Map<UiLocale, string>([
  ["en", ""],
  ["hi", "hi/"],
  ["zh_CN", "zh-cn/"],
  ["zh_TW", "zh-tw/"],
]);

/** URL of a guide subpage in the given language's tree, e.g. guideUrl("setup/polly", "hi") -> .../cloud-speech/hi/setup/polly/. */
export function guideUrl(path: string, locale: UiLocale = "en"): string {
  return `${GUIDE_BASE}${SITE_LOCALE_PREFIX.get(locale) ?? ""}${path}/`;
}

/** Homepage of the extension website (guides, pricing, troubleshooting). */
export function homepageUrl(locale: UiLocale = "en"): string {
  return `${GUIDE_BASE}${SITE_LOCALE_PREFIX.get(locale) ?? ""}`;
}
