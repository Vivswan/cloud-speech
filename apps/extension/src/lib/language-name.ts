import { i18n, type UiLocale } from "@/lib/i18n-runtime";
import { MULTILINGUAL } from "@/providers/types";

/** The language name shown for a voice tag, in the UI locale (the uiLanguage setting), English when
 *  ICU lacks that locale. A tag Intl rejects shows as itself.
 *
 *  Provider tags can carry a dialect tail ICU would print raw (`zh-CN-shaanxi` -> "Chinese (China,
 *  SHAANXI)"), so only the first two subtags are named. */
export function languageDisplayName(code: string, locale: UiLocale): string {
  if (code === MULTILINGUAL) return i18n.t("preferences.multilingual");
  const parts = code.split("-");
  return icuName(parts.length > 2 ? `${parts[0]}-${parts[1]}` : code, locale) ?? code;
}

/** The language alone (`en-IN` -> "English"), for a row that prints the tag's own region after it.
 *
 *  ICU's region parentheses are locale-specific ("English (India)" under en, "英语（印度）" under
 *  zh_CN), so the language cannot be cut out of languageDisplayName's output. */
export function languageBaseName(code: string, locale: UiLocale): string {
  if (code === MULTILINGUAL) return i18n.t("preferences.multilingual");
  return icuName(code.split("-")[0] ?? code, locale) ?? code;
}

function icuName(tag: string, locale: UiLocale): string | undefined {
  try {
    return new Intl.DisplayNames([locale.replace("_", "-"), "en"], { type: "language" }).of(tag);
  } catch {
    return undefined;
  }
}
