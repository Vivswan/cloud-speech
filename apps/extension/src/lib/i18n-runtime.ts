import type { PublicPath } from "wxt/browser";
import type { GeneratedI18nStructure } from "#i18n";
import { browser } from "#imports";
import { getSettings, type UiLanguage, watchSettings } from "@/lib/storage";

/**
 * Runtime i18n with a USER-CHOSEN display language.
 *
 * `browser.i18n.getMessage` (what @wxt-dev/i18n's t() wraps) always answers in
 * the BROWSER's UI language; it cannot honor the `uiLanguage` setting. So this
 * module loads the compiled `_locales/<locale>/messages.json` bundles itself
 * and resolves keys against the chosen locale, falling back to English and
 * finally to getMessage (which also covers calls before initI18n resolves).
 *
 * The message corpus is deliberately simple (flat keys, positional `$1`
 * substitutions, no plurals), so this stays a lookup plus one replace.
 *
 * The `#i18n` import above is TYPE-ONLY (erased at transpile), so this module
 * stays safe in the background graph, which `wxt prepare` imports before the
 * generated `#i18n` module exists (see the fresh-checkout note that used to
 * live in lib/i18n-background.ts).
 */

export type UiLocale = Exclude<UiLanguage, "auto">;

export type MessageKey = keyof GeneratedI18nStructure & string;

/**
 * Map a browser BCP-47 tag onto our four locales. Bare "zh" means Simplified
 * by Chrome's own locale convention. The website's first-visit detect script
 * (apps/web Base.astro) implements this same mapping; keep them in sync.
 */
export function resolveUiLocale(uiLanguage: UiLanguage, browserLang: string): UiLocale {
  if (uiLanguage !== "auto") return uiLanguage;
  const tag = browserLang.toLowerCase();
  if (tag === "hi" || tag.startsWith("hi-")) return "hi";
  if (tag === "zh" || tag.startsWith("zh-")) {
    return /^zh-(hant|tw|hk|mo)/.test(tag) ? "zh_TW" : "zh_CN";
  }
  return "en";
}

type MessageMap = Record<string, string>;

let activeLocale: UiLocale = "en";
let activeMessages: MessageMap | null = null;
let enMessages: MessageMap | null = null;
let version = 0;
let initPromise: Promise<void> | null = null;
// Monotonic guard: refreshes can overlap (rapid switches, watch events) and
// fetch latencies vary; only the NEWEST refresh may commit its result.
let refreshSeq = 0;
// The most recently started refresh; initI18n awaits until this is stable.
let latestRefresh: Promise<void> = Promise.resolve();
// What the newest refresh tried to load (even if the load failed). Lets the
// init loop detect a settings write it would otherwise miss, without
// re-attempting a locale whose bundle persistently fails to load.
let lastAttemptedLocale: UiLocale | null = null;
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

/**
 * Re-derive the locale from FRESH settings and swap the message maps. Reads
 * its own settings snapshot (rather than trusting a caller-supplied one) so
 * the highest-seq call always works from the newest state.
 */
async function refreshLocale(): Promise<void> {
  const seq = ++refreshSeq;
  try {
    const settings = await getSettings();
    const locale = resolveUiLocale(settings.uiLanguage, browser.i18n.getUILanguage());
    lastAttemptedLocale = locale;
    if (locale === activeLocale && activeMessages !== null) return;

    const active = await loadMessages(locale);
    // The en fallback map is best-effort: its failure must not discard a
    // successfully loaded active locale.
    let en = locale === "en" ? active : enMessages;
    if (en === null) en = await loadMessages("en").catch(() => null);

    // Superseded by a newer refresh while fetching; its result wins, not ours.
    if (seq !== refreshSeq) return;

    activeLocale = locale;
    activeMessages = active;
    enMessages = en;
    version += 1;
    for (const listener of listeners) listener();
  } catch (error) {
    // Keep whatever is already loaded; before the first successful load t()
    // degrades to browser-locale getMessage. Never block the UI.
    console.warn("Could not load locale messages:", error);
  }
}

/**
 * Load the chosen locale's messages and keep them in sync with the settings.
 * Idempotent and never rejects; every context (popup, background) calls it at
 * startup. The popup awaits it before first paint, the background before
 * creating menus. The watcher is registered BEFORE the initial load so a
 * change landing mid-load is never missed, and initI18n keeps awaiting until
 * NO newer refresh is in flight, so callers never proceed on a superseded
 * locale (the seq guard makes an early refresh a no-op, not a completion).
 */
export function initI18n(): Promise<void> {
  initPromise ??= (async () => {
    watchSettings(() => {
      latestRefresh = refreshLocale();
    });
    latestRefresh = refreshLocale();
    let awaited: Promise<void>;
    do {
      awaited = latestRefresh;
      await awaited;
      // A watch emit can still be mid-flight (it reads settings before
      // calling back), invisible to the stability check, so re-read the
      // settings ourselves and refresh if a write slipped past. Compared
      // against the last ATTEMPTED locale, not the active one, so a bundle
      // that persistently fails to load can't livelock the loop.
      try {
        const settings = await getSettings();
        const want = resolveUiLocale(settings.uiLanguage, browser.i18n.getUILanguage());
        if (want !== lastAttemptedLocale) latestRefresh = refreshLocale();
      } catch {
        // Storage unreadable; initI18n must still resolve. The reactive
        // watch path picks up whatever lands later.
        break;
      }
    } while (awaited !== latestRefresh);
  })();
  return initPromise;
}

function format(message: string, substitutions?: string[]): string {
  if (!substitutions?.length) return message;
  return message.replace(/\$(\d)/g, (_, index: string) => substitutions[Number(index) - 1] ?? "");
}

/**
 * Translate a dynamic key (e.g. provider labelKeys from the registry): the
 * single sanctioned untyped entry point for registry-driven strings.
 */
export function tDynamic(key: string, substitutions?: string[]): string {
  const flat = key.replaceAll(".", "_");
  const message = activeMessages?.[flat] ?? enMessages?.[flat];
  if (message !== undefined) return format(message, substitutions);
  try {
    // WXT narrows getMessage's key to the generated union; this is the same
    // sanctioned cast for dynamic keys that lib/i18n.ts used to hold.
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

/** Drop-in for the previous `#i18n` / i18n-background imports. */
export const i18n = { t };

export function getActiveLocale(): UiLocale {
  return activeLocale;
}

/** Notifies whenever the resolved locale's messages change (for remounts). */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getLocaleVersion(): number {
  return version;
}
