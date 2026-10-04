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
  const normalized = parts.length > 2 ? `${parts[0]}-${parts[1]}` : code;
  try {
    const names = new Intl.DisplayNames([locale.replace("_", "-"), "en"], { type: "language" });
    return names.of(normalized) ?? code;
  } catch {
    return code;
  }
}
