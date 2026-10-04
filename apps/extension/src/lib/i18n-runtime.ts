import { matchSiteLocale, SITE_LOCALES } from "@cloud-speech/constants";
import type { PublicPath } from "wxt/browser";
import type { GeneratedI18nStructure } from "#i18n";
import { browser } from "#imports";
import {
  readSettingsRecord,
  type Settings,
  type UiLanguage,
  watchSettingsRecord,
} from "@/lib/storage";

/**
 * browser.i18n.getMessage always answers in the BROWSER's UI language and
 * cannot honor the `uiLanguage` setting, so this module loads the compiled
 * `_locales/<locale>/messages.json` bundles itself. The corpus is flat keys
 * with positional `$1` substitutions and no plurals, so a lookup plus one
 * replace is the whole runtime.
 *
 *   lookup order            -> chosen locale, then en, then getMessage
 *   `#i18n` import type-only -> `wxt prepare` imports the background graph before the generated module exists
 */

export type UiLocale = Exclude<UiLanguage, "auto">;

export type MessageKey = keyof GeneratedI18nStructure & string;

/** Uses the shared tag rules from @cloud-speech/constants, so the website's
 *  first-visit detect script agrees. */
export function resolveUiLocale(uiLanguage: UiLanguage, browserLang: string): UiLocale {
  if (uiLanguage !== "auto") return uiLanguage;
  const code = matchSiteLocale(browserLang);
  return SITE_LOCALES.find((locale) => locale.code === code)?.extensionId ?? "en";
}

type MessageMap = Record<string, string>;

let activeLocale: UiLocale = "en";
let activeMessages: MessageMap | null = null;
let enMessages: MessageMap | null = null;
let version = 0;
let initPromise: Promise<void> | null = null;
// Applies overlap (rapid switches, watch emits) and fetch latencies vary; only
// the newest apply may commit its result.
let applySeq = 0;
const listeners = new Set<() => void>();

function messagesUrl(locale: UiLocale): string {
  // _locales/ is emitted by the @wxt-dev/i18n build module but is not part of
  // WXT's generated PublicPath union, hence the cast.
  return browser.runtime.getURL(`/_locales/${locale}/messages.json` as PublicPath);
}

async function loadMessages(locale: UiLocale): Promise<MessageMap> {
  const response = await fetch(messagesUrl(locale));
  if (!response.ok) throw new Error(`Loading ${locale} messages failed: ${response.status}`);
  const raw = (await response.json()) as Record<string, { message?: unknown }>;
  const map: MessageMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value?.message === "string") map[key] = value.message;
  }
  return map;
}

/** True when no newer apply overtook this one, loaded or failed; only then is
 *  the locale settled. */
async function applyLocale(settings: Settings): Promise<boolean> {
  const seq = ++applySeq;
  try {
    const locale = resolveUiLocale(settings.uiLanguage, browser.i18n.getUILanguage());
    if (locale !== activeLocale || activeMessages === null) {
      const active = await loadMessages(locale);
      // The en fallback map is best-effort: its failure must not discard a
      // successfully loaded active locale.
      let en = locale === "en" ? active : enMessages;
      if (en === null) en = await loadMessages("en").catch(() => null);

      if (seq === applySeq) {
        activeLocale = locale;
        activeMessages = active;
        enMessages = en;
        version += 1;
        for (const listener of listeners) listener();
      }
    }
  } catch (error) {
    // Keep whatever is already loaded; before the first successful load t()
    // degrades to browser-locale getMessage. Never block the UI.
    console.warn("Could not load locale messages:", error);
  }
  return seq === applySeq;
}

/** Idempotent and never rejects; the popup awaits it before first paint, the
 *  background before creating menus. Watch before read, as useStorageValue
 *  does, so a write landing during the initial read is never missed. */
export function initI18n(): Promise<void> {
  initPromise ??= new Promise<void>((resolve) => {
    const apply = (settings: Settings) => {
      void applyLocale(settings).then((newest) => {
        if (newest) resolve();
      });
    };
    watchSettingsRecord((record) => apply(record.settings));
    readSettingsRecord().then(
      (record) => {
        if (applySeq === 0) apply(record.settings);
      },
      (error) => {
        // Storage unreadable; the watch still delivers whatever lands later.
        console.warn("Could not read settings for the locale:", error);
        if (applySeq === 0) resolve();
      },
    );
  });
  return initPromise;
}

function format(message: string, substitutions?: string[]): string {
  if (!substitutions?.length) return message;
  return message.replace(/\$(\d)/g, (_, index: string) => substitutions[Number(index) - 1] ?? "");
}

/** The single sanctioned untyped entry point, for registry-driven strings
 *  (provider labelKeys). */
export function tDynamic(key: string, substitutions?: string[]): string {
  const flat = key.replaceAll(".", "_");
  const message = activeMessages?.[flat] ?? enMessages?.[flat];
  if (message !== undefined) return format(message, substitutions);
  try {
    // WXT narrows getMessage's key to the generated union; dynamic keys need
    // the cast.
    const fromBrowser = browser.i18n.getMessage(
      flat as Parameters<typeof browser.i18n.getMessage>[0],
      substitutions,
    );
    if (fromBrowser) return fromBrowser;
  } catch {
    // fakeBrowser in tests has no getMessage; fall through to the key.
  }
  return key;
}

export function t(key: MessageKey, substitutions?: string[]): string {
  return tDynamic(key, substitutions);
}

export const i18n = { t };

export function getActiveLocale(): UiLocale {
  return activeLocale;
}

export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLocaleVersion(): number {
  return version;
}
