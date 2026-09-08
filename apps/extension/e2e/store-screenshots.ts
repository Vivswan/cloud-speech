import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, expect, type Page, test } from "@playwright/test";
import sharp from "sharp";
import type { Playback } from "../src/lib/playback";
import { type FakeSpeechServer, startFakeSpeechServer } from "./fake-provider/server";
import { playbackReaches } from "./playback-waits";

// Renders the Chrome Web Store screenshots listed in docs/store-listing.md
// ("Screenshots") into docs/store-assets/screenshots, 1280 x 800 JPEG, from
// the BUILT extension and the local fake speech server.
// No provider keys: the OpenAI-compatible provider points at the fake server,
// and the OpenAI provider's calls to api.openai.com are routed to it as well,
// so two providers appear connected with the real UI, voice names, and labels.
// The scenes share one browser profile and build on each other in order.
// Run: `bun run screenshots:store` (root or apps/extension); it builds the
// extension first, every time, so a stale bundle is never rendered.

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = join(EXTENSION_DIR, ".output/chrome-mv3");
const OUTPUT_DIR = resolve(EXTENSION_DIR, "../../docs/store-assets/screenshots");

/** Chrome Web Store screenshot size. */
const FRAME = { width: 1280, height: 800 };
/** Every scene is rendered at this device scale and downsampled to the frame
 *  (lanczos3), so text is rasterized at twice the output resolution: sharper
 *  than rendering at the frame's own 1x. */
const RENDER_SCALE = 2;
/** The popup's height: Chrome's popup cap, fixed in popup/index.html. */
const POPUP_HEIGHT = 600;
/** Frame pixels between the popup card and the frame's top and bottom edges. */
const POPUP_MARGIN = 28;
/** The popup's magnification in the frame, 1.24x: its card fills the frame's
 *  height minus the margins. It is applied as device scale, not CSS zoom: the
 *  layout and every click stay in the popup's own CSS pixels, and the voice
 *  picker's popover keeps its place (its positioning ignores root zoom). */
const POPUP_ZOOM = (FRAME.height - 2 * POPUP_MARGIN) / POPUP_HEIGHT;
/** The context-menu page's zoom: the article and the menus read at this size
 *  instead of a 1280 px desktop page's natural, small one. */
const PAGE_ZOOM = 1.2;
const CORNER_RADIUS = 14;
/** Keeps the store uploads and the repository small; a text-heavy 1280 x 800
 *  JPEG at the quality below lands well under it. */
const MAX_FILE_BYTES = 300_000;

/** Canvas behind the popup; the popup's own page colors are stone-50/900. */
const CANVAS = { light: "#e7e5e4", dark: "#292524" } as const;
type Theme = keyof typeof CANVAS;

const OPENAI_API = "https://api.openai.com";
/** Voice names entered in the OpenAI-compatible provider's voice-names field.
 *  The fake server accepts any name, so these are labels that read like the
 *  OpenAI voices next to them; the provider lists them verbatim. */
const CUSTOM_VOICES = "Bella, Sky, Adam, George";
/** Starred in the picker scenes: one OpenAI voice (three engine rows) and two
 *  OpenAI-compatible ones, five rows that fit the list without scrolling. */
const FAVORITES = ["Nova", "Bella", "Adam"];

test.describe.configure({ mode: "serial" });

let server: FakeSpeechServer;
let context: BrowserContext;
let extensionId: string;
let profileDir: string;

test.beforeAll(async () => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  server = await startFakeSpeechServer();

  profileDir = mkdtempSync(join(tmpdir(), "cloud-speech-store-screenshots-"));
  context = await chromium.launchPersistentContext(profileDir, {
    channel: "chromium",
    // Extensions require the NEW headless mode (Playwright's chromium channel).
    headless: true,
    // Popup pages come out at the render scale times the zoom, so the frame,
    // composed at the render scale, shows them zoomed.
    deviceScaleFactor: RENDER_SCALE * POPUP_ZOOM,
    args: [`--disable-extensions-except=${BUILD_DIR}`, `--load-extension=${BUILD_DIR}`],
  });
  // Every OpenAI request the background makes is answered by the fake server
  // at the same path, so the OpenAI provider connects and reads like a real one.
  await context.route(`${OPENAI_API}/**`, async (route) => {
    const request = route.request();
    const headers: Record<string, string> = {};
    for (const name of ["authorization", "content-type"]) {
      const value = request.headers()[name];
      if (value !== undefined) headers[name] = value;
    }
    const upstream = await fetch(`${server.origin}${new URL(request.url()).pathname}`, {
      method: request.method(),
      headers,
      body: request.postData(),
    });
    await route.fulfill({
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "" },
      body: Buffer.from(await upstream.arrayBuffer()),
    });
  });
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  // Each step runs whether or not the one before it failed.
  try {
    await context?.close();
  } finally {
    try {
      if (profileDir) rmSync(profileDir, { recursive: true, force: true });
    } finally {
      await server?.close();
    }
  }
});

// --- Extension state, read where the background keeps it -----------------------

/** The extension API as the browser-side callback below sees it, only the
 *  part it touches. */
declare const chrome: {
  storage: { session: { get(key: string): Promise<Record<string, unknown>> } };
};

/** The playback document (storage.session), as the background last wrote it. */
async function playback(): Promise<Playback> {
  const [worker] = context.serviceWorkers();
  const active = worker ?? (await context.waitForEvent("serviceworker"));
  const stored = await active.evaluate(() => chrome.storage.session.get("playback"));
  return (stored.playback as Playback | undefined) ?? { status: "idle", epoch: 0, rate: 1 };
}

// --- Popup ------------------------------------------------------------------------

type View = "Sandbox" | "Preferences" | "Settings";

async function openPopup(view: View): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByRole("link", { name: view }).click();
  await fitPopup(page);
  return page;
}

/** Size the page the way Chrome sizes the action popup: the document's
 *  preferred width (auto within the bounds popup/index.html sets on body) by
 *  the popup's fixed height. Sized per view, since the views differ in width.
 *  The zoom is derived from POPUP_HEIGHT, so the card is checked against it
 *  here: a card of another size would clip in the frame or float in it. */
async function fitPopup(page: Page): Promise<void> {
  const probe = await page.addStyleTag({ content: "body { width: max-content; }" });
  const width = Math.ceil(await page.evaluate(() => document.body.getBoundingClientRect().width));
  await probe.evaluate((node) => (node as Element).remove());
  const height = await page.evaluate(() => document.documentElement.getBoundingClientRect().height);
  expect(height, "the popup card is POPUP_HEIGHT tall").toBe(POPUP_HEIGHT);
  expect(width * POPUP_ZOOM, "the zoomed popup fits the frame's width").toBeLessThanOrEqual(
    FRAME.width - 2 * POPUP_MARGIN,
  );
  await page.setViewportSize({ width, height });
}

function providerRow(page: Page, id: "openai" | "custom", name: string) {
  const row = page.getByTestId(`provider-${id}`);
  return {
    row,
    header: row.getByText(name, { exact: true }),
    /** The status chip; the row's summary line can carry the same word. */
    chip: (status: "Connected" | "Off") =>
      row.locator("span", { hasText: new RegExp(`^${status}$`) }),
  };
}

async function connectProvider(
  page: Page,
  id: "openai" | "custom",
  name: string,
  fields: Record<string, string>,
): Promise<void> {
  const { row, header, chip } = providerRow(page, id, name);
  await header.click();
  for (const [label, value] of Object.entries(fields)) {
    await row.getByLabel(label).fill(value);
  }
  await row.getByRole("button", { name: "Save & test" }).click();
  await expect(row.getByText(/engines work with your key/)).toBeVisible({ timeout: 30_000 });
  await expect(chip("Connected")).toBeVisible();
  // Collapse the row so the next one opens on a settled accordion.
  await header.click();
}

/** The voice picker's trigger, named after the selected voice. */
function voiceTrigger(page: Page, selected: string) {
  return page.getByRole("button", { name: new RegExp(`^${selected}`) });
}

/** The open picker's first row whose name starts with `voice` (a multi-engine
 *  voice has one row per engine, the provider's first engine first). */
function voiceRow(page: Page, voice: string) {
  return page
    .getByRole("dialog")
    .getByRole("button", { name: new RegExp(`^${voice}`) })
    .first();
}

async function openVoicePicker(page: Page, selected: string): Promise<void> {
  await voiceTrigger(page, selected).click();
  await expect(page.getByPlaceholder("Search voices...")).toBeVisible();
}

/** Filter the open picker down to the starred voices: every row then shows
 *  a filled star, and both providers fit in view. */
async function showFavorites(page: Page): Promise<void> {
  await page
    .getByRole("dialog")
    .getByRole("button", { name: /Favorites$/ })
    .click();
}

// --- Rendering --------------------------------------------------------------------

const RENDER = { width: FRAME.width * RENDER_SCALE, height: FRAME.height * RENDER_SCALE };

/** The popup capture centered on a plain canvas with rounded corners and a
 *  drop shadow, at the render size. The card's origin lands on a whole frame
 *  pixel, so its top and left edges stay sharp through the downsample. */
async function framePopup(popupPng: Buffer, theme: Theme): Promise<Buffer> {
  const { width, height } = await sharp(popupPng).metadata();
  const left = Math.round((FRAME.width - width / RENDER_SCALE) / 2) * RENDER_SCALE;
  const top = Math.round((FRAME.height - height / RENDER_SCALE) / 2) * RENDER_SCALE;
  const radius = CORNER_RADIUS * RENDER_SCALE;
  const rounded = await sharp(popupPng)
    .composite([
      {
        input: Buffer.from(
          `<svg width="${width}" height="${height}"><rect width="${width}" height="${height}" rx="${radius}" fill="#fff"/></svg>`,
        ),
        blend: "dest-in",
      },
    ])
    .png()
    .toBuffer();
  // The shadow's tail fades within the margin below the card (12 px of blur
  // and a 6 px offset leave it about 2 of 255 at the frame's bottom edge), so
  // the edge does not cut off a visible shadow.
  const blur = 12 * RENDER_SCALE;
  const offset = 6 * RENDER_SCALE;
  const shadow = Buffer.from(
    `<svg width="${RENDER.width}" height="${RENDER.height}">` +
      `<filter id="blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${blur}"/></filter>` +
      `<rect x="${left}" y="${top + offset}" width="${width}" height="${height}" rx="${radius}" fill="rgba(0,0,0,0.28)" filter="url(#blur)"/>` +
      `</svg>`,
  );
  return sharp({
    create: { width: RENDER.width, height: RENDER.height, channels: 4, background: CANVAS[theme] },
  })
    .composite([{ input: shadow }, { input: rounded, left, top }])
    .png()
    .toBuffer();
}

/** Downsample the render to the frame and write it as a JPEG, then check the
 *  file that landed: the store wants exactly 1280 x 800 without alpha. */
async function writeScreenshot(name: string, render: Buffer, theme: Theme): Promise<void> {
  const path = join(OUTPUT_DIR, `${name}.jpg`);
  // Every render is the frame at the render scale, so the resize is a pure
  // scale-down and cannot crop or shift the composition.
  const rendered = await sharp(render).metadata();
  expect({ width: rendered.width, height: rendered.height }, `${name} rendered at scale`).toEqual(
    RENDER,
  );
  await sharp(render)
    .flatten({ background: CANVAS[theme] })
    .resize(FRAME.width, FRAME.height, { fit: "fill", kernel: "lanczos3" })
    // 4:4:4 keeps chroma at full resolution, so colored text and thin colored
    // edges do not fringe; mozjpeg shrinks the file at the same quality.
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true })
    .toFile(path);
  const { width, height, channels, format } = await sharp(path).metadata();
  expect({ width, height, channels, format }, `${path} is a 1280 x 800 RGB JPEG`).toEqual({
    width: FRAME.width,
    height: FRAME.height,
    channels: 3,
    format: "jpeg",
  });
  expect(statSync(path).size, `${path} stays a small upload`).toBeLessThan(MAX_FILE_BYTES);
}

async function capturePopup(page: Page, name: string, theme: Theme): Promise<void> {
  const popup = await page.screenshot({ type: "png", animations: "disabled" });
  await writeScreenshot(name, await framePopup(popup, theme), theme);
}

// --- Scenes -------------------------------------------------------------------------
// Numbered like their files (the order in docs/store-listing.md); scene 03 runs
// after 04 because it switches a provider off for its shot.

test("connect the OpenAI and OpenAI-compatible providers", async () => {
  const page = await openPopup("Settings");
  await connectProvider(page, "openai", "OpenAI", { "API Key": "sk-store-screenshots" });
  await connectProvider(page, "custom", "OpenAI-compatible", {
    "Server URL": `${server.origin}/v1`,
    "Voice names, comma-separated (optional)": CUSTOM_VOICES,
  });
  await page.close();
});

test("01 context menu on a web page", async () => {
  // Headless Chromium cannot show its native context menu, so the page draws
  // one: a text-selection menu with the extension's submenu open, the item
  // titles taken from the built locale file and the icon from the build.
  const messages: Record<string, { message: string }> = JSON.parse(
    readFileSync(join(BUILD_DIR, "_locales/en/messages.json"), "utf8"),
  );
  const title = (key: string) => {
    const entry = messages[`context_menu_${key}`];
    if (!entry) throw new Error(`context_menu_${key} is missing from the built locale`);
    return entry.message;
  };
  const icon = `data:image/png;base64,${readFileSync(join(BUILD_DIR, "icons/32.png")).toString("base64")}`;

  // The page needs no extension, so it renders in a plain browser at the
  // render scale itself: the extension context runs at the popup's zoom.
  const browser = await chromium.launch({ channel: "chromium" });
  try {
    const page = await browser.newPage({ viewport: FRAME, deviceScaleFactor: RENDER_SCALE });
    await page.setContent(
      contextMenuScene({
        icon,
        items: [title("read_aloud"), title("read_aloud_1_5x"), title("read_aloud_2x")],
        download: title("download"),
        stop: title("stop_reading"),
      }),
    );
    const png = await page.screenshot({ type: "png", animations: "disabled" });
    await writeScreenshot("01-context-menu", png, "light");
  } finally {
    await browser.close();
  }
});

test("02 preferences: the voice picker", async () => {
  const page = await openPopup("Preferences");
  // The first connected provider's first voice was picked automatically.
  await openVoicePicker(page, "Alloy");
  await voiceRow(page, "Nova").click();
  await expect(voiceTrigger(page, "Nova")).toBeVisible();

  await openVoicePicker(page, "Nova");
  for (const voice of FAVORITES) {
    await voiceRow(page, voice).locator("..").getByTitle("Favorite").click();
  }
  await showFavorites(page);
  await expect(voiceRow(page, "Adam")).toBeVisible();
  await capturePopup(page, "02-preferences-voice-picker", "light");
  await page.close();
});

test("04 sandbox: the mini-player during a read", async () => {
  const page = await openPopup("Sandbox");
  await expect(page.getByText("Text is sent to OpenAI")).toBeVisible();
  await page.getByRole("button", { name: "Play" }).click();
  // A visibly advanced timeline: the read is two 12 s replies stitched.
  await playbackReaches(playback, "playing", { where: (doc) => doc.currentTime > 6 });
  await expect(page.getByRole("button", { name: "Pause" })).toBeVisible();
  await capturePopup(page, "04-sandbox-player", "light");
  await page.getByRole("button", { name: "Pause" }).click();
  await page.close();
});

test("03 settings: the provider accordion", async () => {
  const page = await openPopup("Settings");
  const custom = providerRow(page, "custom", "OpenAI-compatible");
  await custom.header.click();
  await custom.row.getByRole("switch", { name: "Enabled" }).click();
  await expect(custom.chip("Off")).toBeVisible();

  const openai = providerRow(page, "openai", "OpenAI");
  await openai.header.click();
  await expect(openai.row.getByRole("button", { name: "Save & test" })).toBeVisible();
  await fitPopup(page);
  await capturePopup(page, "03-settings-providers", "light");

  // Back on, so the dark scene shows both providers' chips again.
  await custom.header.click();
  await custom.row.getByRole("switch", { name: "Enabled" }).click();
  await expect(custom.chip("Connected")).toBeVisible();
  await page.close();
});

test("05 preferences in the dark theme", async () => {
  const page = await openPopup("Preferences");
  await page.getByRole("combobox").filter({ hasText: "System" }).click();
  await page.getByRole("option", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await openVoicePicker(page, "Nova");
  await showFavorites(page);
  await expect(voiceRow(page, "Adam")).toBeVisible();
  await capturePopup(page, "05-preferences-dark", "dark");
  await page.close();
});

// --- The context menu page ------------------------------------------------------

interface ContextMenuScene {
  icon: string;
  /** The read-aloud items, in menu order. */
  items: string[];
  download: string;
  stop: string;
}

const ARTICLE = {
  kicker: "Accessibility",
  title: "Reading the web with your ears",
  lede: "Long articles are easier to follow when the browser reads them aloud. A text-to-speech extension turns any paragraph into speech with a voice you choose.",
  selected:
    "Highlight the text you want to hear, right-click it, and pick a reading speed. The audio plays in the browser while you keep scrolling, and the same menu can save the reading as an audio file.",
  after:
    "Cloud voices from Amazon Polly, Azure, Google Cloud, and OpenAI sound natural in dozens of languages, and the extension uses your own account for each one.",
};

function contextMenuScene(scene: ContextMenuScene): string {
  const item = (label: string) => `<li class="item">${label}</li>`;
  // Chrome trims the quoted selection to fit the menu's width.
  const search = `Search Google for "${ARTICLE.selected.slice(0, 22)}..."`;
  // The page is zoomed as a whole, so its CSS pixels are the frame's pixels
  // divided by the zoom: the layout below fills that smaller box.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  html { zoom: ${PAGE_ZOOM}; }
  html, body { margin: 0; height: 100%; background: #fff; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1c1917; -webkit-font-smoothing: antialiased;
  }
  .bar { height: 56px; background: #f5f5f4; border-bottom: 1px solid #e7e5e4; }
  .bar .url {
    position: absolute; top: 14px; left: 160px; width: 730px; height: 28px;
    border-radius: 14px; background: #fff; border: 1px solid #e7e5e4;
    font-size: 13px; color: #78716c; line-height: 28px; padding-left: 14px;
  }
  main { max-width: 680px; margin: 56px auto 0; }
  .kicker { font-size: 13px; font-weight: 700; letter-spacing: 0.08em; color: #b45309; text-transform: uppercase; }
  h1 { font-size: 40px; line-height: 1.15; margin: 12px 0 20px; font-weight: 800; letter-spacing: -0.01em; }
  p { font-size: 19px; line-height: 1.6; margin: 0 0 22px; color: #292524; }
  .selection { background: #b4d5fe; color: #1c1917; }
  .menu {
    position: absolute; width: 268px; padding: 5px 0; margin: 0; list-style: none;
    background: #fff; border: 1px solid #d6d3d1; border-radius: 8px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18); font-size: 13px; color: #1c1917;
  }
  .item {
    padding: 5px 12px 5px 34px; line-height: 18px; position: relative;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .item.open { background: #e7e5e4; }
  .item.parent::after {
    content: ""; position: absolute; right: 12px; top: 10px; border: 4px solid transparent;
    border-left-color: #57534e;
  }
  .item img { position: absolute; left: 10px; top: 6px; width: 16px; height: 16px; }
  .sep { height: 1px; margin: 5px 0; background: #e7e5e4; }
  .main-menu { left: 590px; top: 352px; width: 260px; }
  .sub-menu { left: 846px; top: 448px; width: 196px; }
</style>
</head>
<body>
  <div class="bar"><div class="url">example.org/reading-the-web-with-your-ears</div></div>
  <main>
    <div class="kicker">${ARTICLE.kicker}</div>
    <h1>${ARTICLE.title}</h1>
    <p>${ARTICLE.lede}</p>
    <p><span class="selection">${ARTICLE.selected}</span></p>
    <p>${ARTICLE.after}</p>
  </main>
  <ul class="menu main-menu">
    ${item("Copy")}
    ${item(search)}
    ${item("Print...")}
    <li class="sep"></li>
    <li class="item open parent"><img src="${scene.icon}" alt="">Cloud Speech</li>
    <li class="sep"></li>
    ${item("Inspect")}
  </ul>
  <ul class="menu sub-menu">
    ${scene.items.map((label) => item(label)).join("\n    ")}
    ${item(scene.download)}
    <li class="sep"></li>
    ${item(scene.stop)}
  </ul>
</body>
</html>`;
}
