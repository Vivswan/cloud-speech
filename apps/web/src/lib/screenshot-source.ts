import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { STORE_SCREENSHOTS_URL } from "./site";

// The walkthrough page's screenshots: which files exist and where they load
// from. The frame shows the store file, the exact crop the store gets, and
// the lightbox the whole composition; both come from one set, the published
// one (STORE_SCREENSHOTS_URL) in a build and the local render in `astro dev`
// (served by lib/dev-screenshots.ts). docs/store-listing.md describes the set.

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

/** The set's directory name: under the site base in dev, and in the
 *  extension's .output directory. */
export const STORE_SCREENSHOTS_DIR = "store-screenshots";

/** The local render, written by `bun run screenshots:store`. */
export const RENDER_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../extension/.output",
  STORE_SCREENSHOTS_DIR,
);

/** Whether a complete local render exists: the renderer removes crops.json
 *  first and writes it last, so the file marks a finished set. Checked per
 *  page render, so a new render shows on the next reload. */
export const hasLocalRender = () => existsSync(join(RENDER_DIR, "crops.json"));

export interface ScreenshotSource {
  /** `import.meta.env.DEV`: an `astro dev` server, never a build. */
  dev: boolean;
  /** hasLocalRender() */
  rendered: boolean;
  /** `import.meta.env.BASE_URL`, with its trailing slash. */
  base: string;
}

/** The URL prefix a scene's file name is appended to: the local render in dev
 *  when there is one, the published set otherwise. A build never points at
 *  the local copy, whether or not one exists. */
export function storeScreenshotsBase({ dev, rendered, base }: ScreenshotSource): string {
  if (dev && rendered) return `${base}${STORE_SCREENSHOTS_DIR}/`;
  return STORE_SCREENSHOTS_URL;
}
