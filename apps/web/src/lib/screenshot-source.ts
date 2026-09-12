import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_LOCALES, type StoreLocale } from "@cloud-speech/constants";
import { STORE_SCREENSHOTS_URL } from "./site";

// The screenshot sets share one layout on the published branch and in the dev server (lib/dev-screenshots.ts);
// docs/store-listing.md describes them.
//   <root>/<file>                -> the English set
//   <root>/<storeLocale>/<file>  -> one set per language the extension ships (`zh-CN/`)

/** The scenes, in the renderer's file order (apps/extension/tests/e2e/store-screenshots.ts). */
export const SCREENSHOT_SCENES = [
  "01-context-menu",
  "02-preferences-voice-picker",
  "03-settings-providers",
  "04-sandbox-player",
  "05-preferences-dark",
  "06-sandbox-reading-page",
  "07-preferences-prosody",
  "08-settings-sync",
  "09-settings-save-test-error",
  "10-preferences-shortcuts",
] as const;

export type ScreenshotScene = (typeof SCREENSHOT_SCENES)[number];

/** The store upload, a focus crop of the full composition. */
export const STORE_SIZE = { width: 1280, height: 800 };
export const FULL_SIZE = { width: 2560, height: 1600 };

export const storeFile = (scene: ScreenshotScene) => `${scene}.jpg`;
export const fullFile = (scene: ScreenshotScene) => `${scene}-2x.jpg`;

export const STORE_SCREENSHOTS_DIR = "store-screenshots";

/** English, the first site locale: the set also served at the sets' root. */
export const FALLBACK_LOCALE: StoreLocale = SITE_LOCALES[0].storeLocale;

/** The local render, written by `bun run screenshots:store`. */
export const RENDER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../extension/.output",
  STORE_SCREENSHOTS_DIR,
);

/** crops.json marks a finished set: the renderer removes it first and writes it last, and
 *  `bun run screenshots:store -- --project=hi` finishes one set only. */
export const hasLocalRender = (locale: StoreLocale, renderDir: string = RENDER_DIR) =>
  [locale, FALLBACK_LOCALE].some((set) => existsSync(join(renderDir, set, "crops.json")));

export interface ScreenshotSource {
  /** `import.meta.env.DEV`: an `astro dev` server, never a build. */
  dev: boolean;
  /** hasLocalRender(locale) */
  rendered: boolean;
  /** `import.meta.env.BASE_URL`, with its trailing slash. */
  base: string;
}

/** A build never points at the local render, whether or not one exists; scripts/check-links.mjs fails one that does. */
export function storeScreenshotsBase({ dev, rendered, base }: ScreenshotSource): string {
  if (dev && rendered) return `${base}${STORE_SCREENSHOTS_DIR}/`;
  return STORE_SCREENSHOTS_URL;
}

export interface SceneFiles {
  store: string;
  full: string;
}

/** Both are returned because only the browser learns, at load time, whether the locale's file exists;
 *  Screenshot.astro swaps in the fallback on error. */
export function sceneSources(
  base: string,
  locale: StoreLocale,
  scene: ScreenshotScene,
): { primary: SceneFiles; fallback: SceneFiles } {
  const files = (prefix: string): SceneFiles => ({
    store: `${prefix}${storeFile(scene)}`,
    full: `${prefix}${fullFile(scene)}`,
  });
  return { primary: files(`${base}${locale}/`), fallback: files(base) };
}
