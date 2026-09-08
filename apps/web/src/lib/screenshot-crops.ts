// The walkthrough page's screenshots and where each one's focus crop sits.
// The store renderer (apps/extension/e2e/store-screenshots.ts) writes two
// files per scene, the 1280 x 800 store crop and the 2560 x 1600 whole
// composition, plus crops.json describing the crop's window over the
// composition. Screenshot.astro shows the whole composition inside a frame
// positioned so exactly that window is visible, and opens the whole image on
// click; the window geometry is therefore build-time data for the page.
//
// Where the geometry comes from, in order:
//   1. crops.json in the renderer's output directory, when it exists: a
//      `bun run screenshots:store` before the web build picks up the current
//      windows automatically.
//   2. FALLBACK_CROPS below otherwise (every CI build of the site, which never
//      renders the extension): a copy of the renderer's current windows,
//      refreshed by hand when a scene's composition changes.

/** The scenes, in the renderer's file order. */
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
] as const;

export type ScreenshotScene = (typeof SCREENSHOT_SCENES)[number];

export interface CropWindow {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface ScreenshotCrop {
  scene: ScreenshotScene;
  /** The whole composition's file name, relative to STORE_SCREENSHOTS_URL. */
  full: string;
  /** The whole composition's pixel size. */
  size: { width: number; height: number };
  /** The store crop's window, in the whole composition's pixels. */
  window: CropWindow;
}

const RENDER_SIZE = { width: 2560, height: 1600 };

const fallbackWindows: Record<ScreenshotScene, CropWindow> = {
  "01-context-menu": { left: 627, top: 695, width: 1280, height: 800 },
  "02-preferences-voice-picker": { left: 848, top: 300, width: 1280, height: 800 },
  "03-settings-providers": { left: 833, top: 461, width: 1311, height: 819 },
  "04-sandbox-player": { left: 829, top: 743, width: 1320, height: 825 },
  "05-preferences-dark": { left: 848, top: 300, width: 1280, height: 800 },
  "06-sandbox-reading-page": { left: 26, top: 16, width: 2509, height: 1568 },
  "07-preferences-prosody": { left: 25, top: 16, width: 2509, height: 1568 },
  "08-settings-sync": { left: 760, top: 656, width: 1459, height: 912 },
  "09-settings-save-test-error": { left: 678, top: 476, width: 1622, height: 1014 },
};

export const FALLBACK_CROPS: Record<ScreenshotScene, ScreenshotCrop> = Object.fromEntries(
  SCREENSHOT_SCENES.map((scene) => [
    scene,
    { scene, full: `${scene}-2x.jpg`, size: RENDER_SIZE, window: fallbackWindows[scene] },
  ]),
) as Record<ScreenshotScene, ScreenshotCrop>;

/** The renderer's crops.json as raw text, keyed by its path, or an empty
 *  record when the file does not exist. Vite resolves the glob against this
 *  source file when it builds the page, so the location holds wherever the
 *  bundled module ends up. The text is read while the pages render and is
 *  not part of the served site. */
const renderedCropsText = import.meta.glob<string>(
  "../../../extension/.output/store-screenshots/crops.json",
  { eager: true, query: "?raw", import: "default" },
);

function isScene(value: unknown): value is ScreenshotScene {
  return typeof value === "string" && (SCREENSHOT_SCENES as readonly string[]).includes(value);
}

function isPositive(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

/** A box with a usable size: zero or negative dimensions would put the frame
 *  at a 0 aspect ratio and the image at an infinite width. */
function isWindow(value: unknown): value is CropWindow {
  if (typeof value !== "object" || value === null) return false;
  const { left, top, width, height } = value as Record<string, unknown>;
  return Number.isFinite(left) && Number.isFinite(top) && isPositive(width) && isPositive(height);
}

function isSize(value: unknown): value is { width: number; height: number } {
  if (typeof value !== "object" || value === null) return false;
  const { width, height } = value as Record<string, unknown>;
  return isPositive(width) && isPositive(height);
}

/** Parses a crops.json entry; anything malformed is skipped so one odd entry
 *  cannot break the build, its scene just keeps the fallback window. */
function parseCrop(entry: unknown): ScreenshotCrop | undefined {
  if (typeof entry !== "object" || entry === null) return undefined;
  const { scene, full, size, window } = entry as Record<string, unknown>;
  if (!isScene(scene) || typeof full !== "string" || !isSize(size) || !isWindow(window)) {
    return undefined;
  }
  return { scene, full, size, window };
}

/** The renderer's crops, when its crops.json is present and parses; a file
 *  that does not parse is reported and treated as absent, so a broken local
 *  render never fails the site build. */
function readRenderedCrops(): Partial<Record<ScreenshotScene, ScreenshotCrop>> {
  const crops: Partial<Record<ScreenshotScene, ScreenshotCrop>> = {};
  for (const [path, text] of Object.entries(renderedCropsText)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      console.warn(`${path}: not valid JSON, using the checked-in crop windows (${error})`);
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    for (const entry of parsed) {
      const crop = parseCrop(entry);
      if (crop) crops[crop.scene] = crop;
    }
  }
  return crops;
}

/** Every scene's crop: the renderer's current window when its crops.json is
 *  present, the checked-in one otherwise. Read once per build. */
export const screenshotCrops: Record<ScreenshotScene, ScreenshotCrop> = {
  ...FALLBACK_CROPS,
  ...readRenderedCrops(),
};
