import { createI18n } from "@wxt-dev/i18n";

/**
 * i18n for BACKGROUND-graph modules (background.ts, errors.ts, …).
 *
 * Deliberately NOT the generated `#i18n` module: WXT imports the background
 * entrypoint's whole module graph DURING `wxt prepare`, before the generated
 * module exists — so a `#i18n` import here makes a fresh checkout fail its
 * postinstall (chicken-and-egg). Same runtime behavior, minus generated key
 * types; key correctness is covered by the locale parity tests and the typed
 * popup usages of the same keys.
 */
export const i18n = createI18n();
