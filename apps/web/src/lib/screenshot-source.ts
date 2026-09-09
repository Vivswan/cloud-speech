import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_LOCALES, type StoreLocale } from "@cloud-speech/constants";
import { STORE_SCREENSHOTS_URL } from "./site";

// The walkthrough page's screenshots: which files exist and where they load
// from. The frame shows the store file, the exact crop the store gets, and
// the lightbox the whole composition; both come from one set, the published
// one (STORE_SCREENSHOTS_URL) in a build and the local render in `astro dev`
// (served by lib/dev-screenshots.ts). There is one set per language the
// extension ships, under the store's code for it (`zh-CN/`), and a page shows
// the set of its own language; English is also at the root, where the set
// has always been, and is what a page falls back to for a file its own
// language's set lacks. docs/store-listing.md describes the sets.

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

/** The store upload, a focus crop of the composition. */
export const STORE_SIZE = { width: 1280, height: 800 };
/** The whole composition. */
export const FULL_SIZE = { width: 2560, height: 1600 };

export const storeFile = (scene: ScreenshotScene) => `${scene}.jpg`;
export const fullFile = (scene: ScreenshotScene) => `${scene}-2x.jpg`;

/** The sets' directory name: under the site base in dev, and in the
 *  extension's .output directory. Each set is a directory under it, named
 *  after its store locale. */
export const STORE_SCREENSHOTS_DIR = "store-screenshots";

/** The set every page can fall back to: English, the first locale, which the
 *  published branch and the dev server also serve at the sets' root. */
export const FALLBACK_LOCALE: StoreLocale = SITE_LOCALES[0].storeLocale;

/** The local render, written by `bun run screenshots:store`: one directory
 *  per store locale. */
export const RENDER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../extension/.output",
  STORE_SCREENSHOTS_DIR,
);

/** Whether a page in `locale` has a complete local render to show: its own
 *  set, or the fallback set it would fall back to. The renderer removes a
 *  set's crops.json first and writes it last, so the file marks a finished
 *  set (`bun run screenshots:store -- --project=hi` finishes one set only).
 *  Checked per page render, so a new render shows on the next reload. */
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

/** The URL prefix the sets sit under: the local render in dev when there is
 *  one, the published sets otherwise. A build never points at the local copy,
 *  whether or not one exists. */
export function storeScreenshotsBase({ dev, rendered, base }: ScreenshotSource): string {
  if (dev && rendered) return `${base}${STORE_SCREENSHOTS_DIR}/`;
  return STORE_SCREENSHOTS_URL;
}

/** A scene's two files in one set. */
export interface SceneFiles {
  store: string;
  full: string;
}

/** Where a page in `locale` loads a scene from: its own language's set, and
 *  the fallback set at the root for a file that set lacks (the language is
 *  not rendered yet). Only the page can tell which, when the file loads, so
 *  the component carries both. */
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
