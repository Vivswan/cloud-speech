import { STORE_SCREENSHOTS_URL } from "./site";

// Where the walkthrough page loads its screenshots from: the published set
// (STORE_SCREENSHOTS_URL) in a build, the local render in `astro dev` (served
// by lib/dev-screenshots.ts). docs/store-listing.md describes the pipeline.

/** The directory's name under the site base in dev, and its name in the
 *  extension's .output directory. */
export const STORE_SCREENSHOTS_DIR = "store-screenshots";

export interface ScreenshotSource {
  /** `import.meta.env.DEV`: an `astro dev` server, never a build. */
  dev: boolean;
  /** Whether a local render exists (its crops.json was found). */
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
