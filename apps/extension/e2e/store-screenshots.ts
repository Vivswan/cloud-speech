import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, expect, type Locator, type Page, test } from "@playwright/test";
import sharp from "sharp";
import { silentMp3 } from "./fake-provider/mp3";
import {
  DEFAULT_AUDIO_SECONDS,
  type FakeSpeechServer,
  startFakeSpeechServer,
} from "./fake-provider/server";
import { type ExtensionSession, launchExtension, readPlayback } from "./fixtures";
import { playbackReaches } from "./playback-waits";

// Renders the store-listing screenshots listed in docs/store-listing.md
// ("Screenshots") into .output/store-screenshots, from the BUILT extension and
// the local fake speech server. Two files per scene, and one for the set:
//   <scene>.jpg     1280 x 800, the Chrome Web Store upload: a focus crop, so
//                   the labels it shows are large and sharp
//   <scene>-2x.jpg  2560 x 1600, the whole composition for the website and README
//   crops.json      where each store crop sits in its -2x file, so the website
//                   can show the crop and keep the whole image behind it
// No provider keys: the OpenAI-compatible provider points at the fake server,
// the OpenAI provider's calls to api.openai.com are routed to it as well, and
// Azure Speech is answered in this process (a small roster, silent audio), so
// three providers appear connected with the real UI, voice names, and labels.
// The scenes share one browser profile and build on each other in order.
// Run: `bun run screenshots:store` (root or apps/extension); it builds the
// extension first, every time, so a stale bundle is never rendered. CI runs
// it on every green push to main (post-green.yml) and publishes the set to
// the orphan store-screenshots branch (publish-screenshots.yml), so the files
// are never committed to main.

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BUILD_DIR = join(EXTENSION_DIR, ".output/chrome-mv3");
const OUTPUT_DIR = join(EXTENSION_DIR, ".output/store-screenshots");

/** The composition's coordinate space, and the store file's size. */
const FRAME = { width: 1280, height: 800 };
/** Every composition is rendered at this device scale; the web file is that
 *  render as is, and the store file is a window over it. */
const RENDER_SCALE = 2;
const RENDER = { width: FRAME.width * RENDER_SCALE, height: FRAME.height * RENDER_SCALE };
/** The store crop's window, in frame pixels: the part of the render that
 *  fills the store file one render pixel per output pixel. A scene's focus
 *  that does not fit in it gets a larger window, scaled down to the file. */
const WINDOW = { width: FRAME.width / RENDER_SCALE, height: FRAME.height / RENDER_SCALE };
/** The popup's height: Chrome's popup cap, fixed in popup/index.html. */
const POPUP_HEIGHT = 600;
/** Frame pixels between the popup card and the frame's top and bottom edges. */
const POPUP_MARGIN = 28;
/** The popup's magnification in the frame, 1.24x: its card fills the frame's
 *  height minus the margins. It is applied as device scale, not CSS zoom: the
 *  layout and every click stay in the popup's own CSS pixels, and the voice
 *  picker's popover keeps its place (its positioning ignores root zoom). In
 *  the store crop a popup CSS pixel is therefore RENDER_SCALE x 1.24 output
 *  pixels: a 12 px label lands at about 30 px. */
const POPUP_ZOOM = (FRAME.height - 2 * POPUP_MARGIN) / POPUP_HEIGHT;
const POPUP_SCALE = RENDER_SCALE * POPUP_ZOOM;
const CORNER_RADIUS = 14;

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

/** Azure Speech, for the prosody scene: the one provider here whose voices
 *  take pitch, volume, and a speaking style. Its region and roster, in the
 *  shape the voice list endpoint returns; Jenny's styles fill the style
 *  select. Every synthesis (the availability probe, a read) gets silent MP3. */
const AZURE_REGION = "eastus";
const AZURE_VOICES = [
  { ShortName: "en-US-JennyNeural", LocalName: "Jenny", Locale: "en-US", Gender: "Female" },
  { ShortName: "en-US-GuyNeural", LocalName: "Guy", Locale: "en-US", Gender: "Male" },
  { ShortName: "en-GB-SoniaNeural", LocalName: "Sonia", Locale: "en-GB", Gender: "Female" },
].map((voice) => ({
  ...voice,
  VoiceType: "Neural",
  StyleList: voice.LocalName === "Jenny" ? ["assistant", "chat", "cheerful", "newscast"] : [],
}));

test.describe.configure({ mode: "serial" });

let server: FakeSpeechServer;
let extension: ExtensionSession;

test.beforeAll(async () => {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  server = await startFakeSpeechServer();

  extension = await launchExtension("cloud-speech-store-screenshots-", {
    deviceScaleFactor: POPUP_SCALE,
    // The scenes locate English labels, so the browser is pinned to English
    // regardless of the host.
    locale: "en-US",
  });
  // Every OpenAI request the background makes is answered by the fake server
  // at the same path, so the OpenAI provider connects and reads like a real one.
  await extension.context.route(`${OPENAI_API}/**`, async (route) => {
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
  await extension.context.route(
    `https://${AZURE_REGION}.tts.speech.microsoft.com/**`,
    async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (request.method() === "GET" && path === "/cognitiveservices/voices/list") {
        await route.fulfill({ json: AZURE_VOICES });
      } else if (request.method() === "POST" && path === "/cognitiveservices/v1") {
        await route.fulfill({
          contentType: "audio/mpeg",
          body: Buffer.from(silentMp3(DEFAULT_AUDIO_SECONDS)),
        });
      } else {
        await route.fulfill({ status: 404, body: `no Azure stub for ${request.method()} ${path}` });
      }
    },
  );
});

test.afterAll(async () => {
  // The server closes whether or not the browser did.
  try {
    await extension?.close();
  } finally {
    await server?.close();
  }
});

// --- Popup ------------------------------------------------------------------------

/** The extension API as the callback in `readAloud` sees it inside a popup
 *  page, only the part it touches. */
declare const chrome: {
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

/** Start a read of `text` the way the context menu and the keyboard shortcut
 *  do: a background request, sent from a popup page and awaited to its reply. */
async function readAloud(page: Page, text: string): Promise<void> {
  await page.evaluate(
    (payload) => chrome.runtime.sendMessage({ to: "background", id: "readAloud", payload }),
    { text },
  );
}

type View = "Sandbox" | "Preferences" | "Settings";

async function openPopup(view: View): Promise<Page> {
  const page = await extension.openPopup();
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

/** Scroll the view to its end, the way a user reaches the bottom of a view
 *  taller than the popup: every scrollable box on the page goes to its end. */
async function scrollToEnd(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (const node of document.querySelectorAll("*")) {
      if (node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === "auto") {
        node.scrollTop = node.scrollHeight;
      }
    }
  });
}

type ProviderId = "azure" | "google" | "openai" | "custom";

function providerRow(page: Page, id: ProviderId, name: string) {
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
  id: ProviderId,
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

/** The open picker's Favorites chip; clicking it filters the list down to the
 *  starred voices: every row then shows a filled star, and both providers
 *  fit in view. */
function favoritesChip(page: Page) {
  return page.getByRole("dialog").getByRole("button", { name: /Favorites$/ });
}

/** The picker scenes' focus: the trigger (the selected voice), the search
 *  box, the chips row, and the first four rows, in the popup's CSS pixels.
 *  The window ends on the fourth row's bottom edge, so no row is cut; the
 *  trigger then sits about 10 px below the window's top. */
async function pickerFocus(page: Page): Promise<Focus> {
  const fit = union(
    // The open picker's trigger; the rows in the popover carry the name too.
    await boxOf(page.getByRole("button", { name: /^Nova/, expanded: true })),
    await boxOf(page.getByPlaceholder("Search voices...")),
    await boxOf(favoritesChip(page)),
    // The row around the fourth voice's button: the button ends above the
    // row's bottom padding.
    await boxOf(voiceRow(page, "Bella").locator("..")),
  );
  return { fit, pad: 0, anchor: "bottom" };
}

/** The focus of a scene that shows the whole popup: the card with 20 frame
 *  px around it, so the window is nearly the frame and the file shows the
 *  popup a little under half its render size. At that distance the card's
 *  shadow has all but faded (about 9 of 255), so the crop's edge shows no
 *  step; the card's own margin is 28. */
async function wholePopup(page: Page): Promise<Focus> {
  return { fit: await boxOf(page.locator("html")), pad: 20, anchor: "center" };
}

// --- Geometry -------------------------------------------------------------------

/** A rectangle: in a page's CSS pixels when it comes from a locator, in
 *  frame pixels once it is placed in a composition. */
interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The element's box once the page's animations have finished: a popover
 *  still sliding in would place the crop a few pixels off. */
async function boxOf(locator: Locator): Promise<Box> {
  await locator.page().evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished),
    ),
  );
  const box = await locator.boundingBox();
  if (!box) throw new Error(`${locator} has no box: it is not rendered`);
  return box;
}

function union(first: Box, ...rest: Box[]): Box {
  let { x, y } = first;
  let right = first.x + first.width;
  let bottom = first.y + first.height;
  for (const box of rest) {
    x = Math.min(x, box.x);
    y = Math.min(y, box.y);
    right = Math.max(right, box.x + box.width);
    bottom = Math.max(bottom, box.y + box.height);
  }
  return { x, y, width: right - x, height: bottom - y };
}

/** Where a scene's store crop looks. */
interface Focus {
  /** What the crop must show whole, with `pad` frame pixels around it. */
  fit: Box;
  pad: number;
  /** Where the fit sits in the window: at its top, its middle, or its
   *  bottom. The window is always centered on the fit horizontally. */
  anchor: "top" | "center" | "bottom";
}

/** The store crop's window, in frame pixels: WINDOW when the padded fit is
 *  within it (one render pixel per output pixel), otherwise the padded fit
 *  grown to the frame's aspect, which the store file then scales down. A
 *  window that leaves the frame is an error, never moved back in: a scene
 *  that placed its edge on a line or a card corner would silently lose it. */
function storeWindow(name: string, { fit, pad, anchor }: Focus): Box {
  const padded = {
    x: fit.x - pad,
    y: fit.y - pad,
    width: fit.width + 2 * pad,
    height: fit.height + 2 * pad,
  };
  const scale = Math.max(1, padded.width / WINDOW.width, padded.height / WINDOW.height);
  const width = WINDOW.width * scale;
  const height = WINDOW.height * scale;
  const x = padded.x + (padded.width - width) / 2;
  const y =
    anchor === "top"
      ? padded.y
      : anchor === "bottom"
        ? padded.y + padded.height - height
        : padded.y + (padded.height - height) / 2;
  const window = { x, y, width, height };
  if (x < 0 || y < 0 || x + width > FRAME.width || y + height > FRAME.height) {
    throw new Error(
      `${name}'s store window ${JSON.stringify(window)} leaves the ` +
        `${FRAME.width} x ${FRAME.height} frame (anchor ${anchor}, pad ${pad})`,
    );
  }
  return window;
}

// --- Rendering --------------------------------------------------------------------

/** A scene rendered at RENDER size, with the placement of the page it shows. */
interface Composition {
  render: Buffer;
  /** Maps the page's CSS pixels to frame pixels. */
  toFrame(box: Box): Box;
}

/** The popup capture centered on a plain canvas with rounded corners and a
 *  drop shadow, at the render size. The card's origin lands on a whole frame
 *  pixel, so its edges stay sharp in the scaled store crops too. */
async function framePopup(popupPng: Buffer, theme: Theme): Promise<Composition> {
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
  const render = await sharp({
    create: { width: RENDER.width, height: RENDER.height, channels: 4, background: CANVAS[theme] },
  })
    .composite([{ input: shadow }, { input: rounded, left, top }])
    .png()
    .toBuffer();
  return {
    render,
    toFrame: (box) => ({
      x: left / RENDER_SCALE + box.x * POPUP_ZOOM,
      y: top / RENDER_SCALE + box.y * POPUP_ZOOM,
      width: box.width * POPUP_ZOOM,
      height: box.height * POPUP_ZOOM,
    }),
  };
}

/** One entry of crops.json: where a scene's store crop sits in its full
 *  render, in that image's pixels. */
interface Crop {
  scene: string;
  /** The store file, `<scene>.jpg`. */
  store: string;
  /** The full render, `<scene>-2x.jpg`, and its size. */
  full: string;
  size: { width: number; height: number };
  /** The store crop's rectangle in the full render. */
  window: { left: number; top: number; width: number; height: number };
}

/** Filled as the scenes write their files; the last test writes crops.json. */
const crops: Crop[] = [];

/** Both files of a scene from its composition: the render as the web file,
 *  and the store window over it as the store file. Each file is checked after
 *  it landed: the store wants exactly 1280 x 800 without alpha. */
async function writeScene(
  name: string,
  composition: Composition,
  theme: Theme,
  focus: Focus,
): Promise<void> {
  const { render } = composition;
  const rendered = await sharp(render).metadata();
  expect({ width: rendered.width, height: rendered.height }, `${name} rendered at scale`).toEqual(
    RENDER,
  );
  // 4:4:4 keeps chroma at full resolution, so colored text and thin colored
  // edges do not fringe; mozjpeg shrinks the file at the same quality.
  const jpeg = { quality: 92, chromaSubsampling: "4:4:4", mozjpeg: true } as const;

  const webPath = join(OUTPUT_DIR, `${name}-2x.jpg`);
  await sharp(render).flatten({ background: CANVAS[theme] }).jpeg(jpeg).toFile(webPath);
  await expectJpeg(webPath, RENDER);

  const window = storeWindow(name, { ...focus, fit: composition.toFrame(focus.fit) });
  const region = {
    left: Math.round(window.x * RENDER_SCALE),
    top: Math.round(window.y * RENDER_SCALE),
    width: Math.round(window.width * RENDER_SCALE),
    height: Math.round(window.height * RENDER_SCALE),
  };
  const inside =
    region.left >= 0 &&
    region.top >= 0 &&
    region.left + region.width <= RENDER.width &&
    region.top + region.height <= RENDER.height;
  expect(
    inside,
    `${name}'s store window ${JSON.stringify(region)} lies inside its ${RENDER.width} x ${RENDER.height} render`,
  ).toBe(true);
  let store = sharp(render).extract(region).flatten({ background: CANVAS[theme] });
  // A window larger than the store file is scaled down; the plain window is
  // written pixel for pixel.
  if (region.width !== FRAME.width || region.height !== FRAME.height) {
    store = store.resize(FRAME.width, FRAME.height, { fit: "fill", kernel: "lanczos3" });
  }
  const storePath = join(OUTPUT_DIR, `${name}.jpg`);
  await store.jpeg(jpeg).toFile(storePath);
  await expectJpeg(storePath, FRAME);
  crops.push({
    scene: name,
    store: `${name}.jpg`,
    full: `${name}-2x.jpg`,
    size: { ...RENDER },
    window: region,
  });
  console.log(
    `${name}: store crop ${Math.round(window.width)} x ${Math.round(window.height)} at ` +
      `(${Math.round(window.x)}, ${Math.round(window.y)}), ` +
      `${(FRAME.width / window.width).toFixed(2)}x the frame`,
  );
}

async function expectJpeg(path: string, size: { width: number; height: number }): Promise<void> {
  const { width, height, channels, format } = await sharp(path).metadata();
  expect({ width, height, channels, format }, `${path} is an RGB JPEG of the right size`).toEqual({
    ...size,
    channels: 3,
    format: "jpeg",
  });
}

async function capturePopup(page: Page, name: string, theme: Theme, focus: Focus): Promise<void> {
  const popup = await page.screenshot({ type: "png", animations: "disabled" });
  await writeScene(name, await framePopup(popup, theme), theme, focus);
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
  // render scale itself: the extension context runs at the popup's scale.
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
    await placeMenus(page);
    // The highlighted paragraph and both menus, which sit inside the
    // article's width: the crop starts in the gap above the paragraph.
    const fit = union(
      await boxOf(page.locator(".selection")),
      await boxOf(page.locator(".main-menu")),
      await boxOf(page.locator(".sub-menu")),
    );
    const render = await page.screenshot({ type: "png", animations: "disabled" });
    await writeScene("01-context-menu", { render, toFrame: (box) => box }, "light", {
      fit,
      pad: 10,
      anchor: "top",
    });
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
  await favoritesChip(page).click();
  await expect(voiceRow(page, "Adam")).toBeVisible();
  await capturePopup(page, "02-preferences-voice-picker", "light", await pickerFocus(page));
  await page.close();
});

test("04 sandbox: the mini-player during a read", async () => {
  const page = await openPopup("Sandbox");
  await expect(page.getByText("Text is sent to OpenAI")).toBeVisible();
  // A passage long enough to fill the text box, so the crop at the popup's
  // bottom shows text being read above the player, not an empty box.
  await page.getByLabel("Text to speak").fill(SANDBOX_TEXT);
  await page.getByRole("button", { name: "Play" }).click();
  // A timeline visibly under way: the fake server answers each sentence
  // chunk with 12 s of audio, and the shot waits for the first to play a while.
  await playbackReaches(() => readPlayback(extension), "playing", {
    where: (doc) => doc.currentTime > 6,
  });
  const pause = page.getByRole("button", { name: "Pause" });
  await expect(pause).toBeVisible();
  // The window reaches from a line boundary of the text box down past the
  // card's bottom edge: the text above the player is cut between two lines,
  // never through one, and the crop ends on the card's corners. The boundary
  // is the last one at least a window's height above that bottom, so the fit
  // is up to one line taller than the window and scales down by that much
  // (a boundary below it would pull the window's bottom out of the frame).
  const card = await boxOf(page.locator("html"));
  const player = await boxOf(pause.locator(".."));
  const textarea = page.getByLabel("Text to speak");
  const box = await boxOf(textarea);
  const { lineHeight, inset } = await textarea.evaluate((node) => {
    const style = getComputedStyle(node);
    return {
      lineHeight: parseFloat(style.lineHeight),
      // The first line's top, from the box's top: border and padding, less
      // whatever the box has scrolled.
      inset: parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop) - node.scrollTop,
    };
  });
  const bottom = card.y + card.height + 12 / POPUP_ZOOM;
  const firstLine = box.y + inset;
  const lines = Math.floor((bottom - WINDOW.height / POPUP_ZOOM - firstLine) / lineHeight);
  const top = firstLine + lines * lineHeight;
  await capturePopup(page, "04-sandbox-player", "light", {
    fit: { x: player.x, y: top, width: player.width, height: bottom - top },
    pad: 0,
    anchor: "top",
  });
  await pause.click();
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
  // The expanded OpenAI card and the Not connected row above it; the window
  // continues below them through the Off row and the Sync heading.
  const fit = union(
    await boxOf(providerRow(page, "google", "Google Cloud TTS").row),
    await boxOf(openai.row),
  );
  await capturePopup(page, "03-settings-providers", "light", { fit, pad: 6, anchor: "top" });

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
  await favoritesChip(page).click();
  await expect(voiceRow(page, "Adam")).toBeVisible();
  await capturePopup(page, "05-preferences-dark", "dark", await pickerFocus(page));
  // Back to the system theme (light in headless Chromium), so the scenes after
  // this one render light again.
  await page.keyboard.press("Escape");
  await page.getByRole("combobox").filter({ hasText: "Dark" }).click();
  await page.getByRole("option", { name: "System" }).click();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await page.close();
});

test("06 sandbox: the popup opened during a read of the page selection", async () => {
  // The popup first: the article opened next is the active tab, the one the
  // mounting Sandbox reads the selection from. The read starts from that
  // selection the way the context menu starts one, and the popup is then
  // reloaded so it opens the way a user opens it mid-read: the player under
  // way, and the banner offering the page's highlighted text.
  const page = await extension.openPopup();
  const article = await extension.context.newPage();
  await article.route(ARTICLE_URL, (route) =>
    route.fulfill({ contentType: "text/html", body: `<p id="quote">${ARTICLE.selected}</p>` }),
  );
  await article.goto(ARTICLE_URL);
  await article.evaluate(() => {
    const quote = document.getElementById("quote");
    if (!quote) throw new Error("the quote paragraph is missing");
    window.getSelection()?.selectAllChildren(quote);
  });
  await readAloud(page, ARTICLE.selected);
  await playbackReaches(() => readPlayback(extension), "playing", {
    where: (doc) => doc.currentTime > 4,
  });
  await page.reload();
  await fitPopup(page);
  await expect(page.getByRole("button", { name: "Use selection" })).toBeVisible();
  const pause = page.getByRole("button", { name: "Pause" });
  await expect(pause).toBeVisible();
  // The banner sits at the top of the view and the player at its bottom, so
  // the crop is the whole popup.
  await capturePopup(page, "06-sandbox-reading-page", "light", await wholePopup(page));
  await pause.click();
  await article.close();
  await page.close();
});

test("07 preferences: the prosody controls and the shortcuts", async () => {
  // Azure Speech joins the connected providers for this scene: its voices are
  // the ones that take pitch, volume, and a speaking style.
  const settings = await openPopup("Settings");
  await connectProvider(settings, "azure", "Azure Speech", {
    "Subscription Key": "store-screenshots-azure",
  });
  await settings.close();

  const page = await openPopup("Preferences");
  // Nova's selection left the picker filtered to multilingual voices; Jenny
  // speaks one language, so the filter goes back to all of them first.
  await page.getByRole("combobox").filter({ hasText: "Multilingual" }).click();
  await page.getByRole("option", { name: "All", exact: true }).click();
  await openVoicePicker(page, "Nova");
  await voiceRow(page, "Jenny").click();
  await expect(voiceTrigger(page, "Jenny")).toBeVisible();
  for (const label of ["Speed", "Pitch", "Volume gain", "Speaking style"]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
  // The view is taller than the popup: scrolled to its end, the Speed slider
  // is at its top and the shortcuts card at its bottom, so the crop is the
  // whole popup.
  await scrollToEnd(page);
  await capturePopup(page, "07-preferences-prosody", "light", await wholePopup(page));
  await page.close();
});

test("08 settings: sync and backup", async () => {
  const page = await openPopup("Settings");
  // Scrolled to its end, the view shows the Sync card (on, saved to the
  // browser account), the Backup card, and the language card above the
  // card's bottom edge. The window starts in the gap above the Sync heading
  // and reaches down past the card's bottom edge; it is as wide as the
  // view's column, so its height, not the popup's width, sets its scale.
  await scrollToEnd(page);
  await expect(page.getByRole("switch", { name: /^Sync settings/ })).toBeChecked();
  const card = await boxOf(page.locator("html"));
  const heading = page.getByText("Sync", { exact: true });
  const top = (await boxOf(heading)).y - 8;
  const bottom = card.y + card.height + 12 / POPUP_ZOOM;
  const column = await boxOf(heading.locator(".."));
  await capturePopup(page, "08-settings-sync", "light", {
    fit: { x: column.x, y: top, width: column.width, height: bottom - top },
    pad: 0,
    anchor: "top",
  });
  await page.close();
});

// Last: in serial mode a failed scene stops the run here, so a partial
// crops.json is never written. Sorted by scene, the order of the files and of
// docs/store-listing.md, whatever order the scenes ran in.
test("crops.json: where each store crop sits in its full render", () => {
  const sorted = [...crops].sort((a, b) => a.scene.localeCompare(b.scene));
  const path = join(OUTPUT_DIR, "crops.json");
  writeFileSync(path, `${JSON.stringify(sorted, null, 2)}\n`);
  console.log(`crops.json: ${sorted.length} scenes`);
});

// --- Sample text ------------------------------------------------------------------

const ARTICLE = {
  kicker: "Accessibility",
  title: "Reading the web with your ears",
  lede:
    "Long articles are easier to follow when the browser reads them aloud. " +
    "A text-to-speech extension turns any paragraph into speech with a voice you choose.",
  selected:
    "Highlight the text you want to hear, right-click it, and pick a reading speed. " +
    "The audio plays while you keep scrolling, and the same menu can save it as an audio file.",
  after:
    "Cloud voices from Amazon Polly, Azure, Google Cloud, and OpenAI sound natural in dozens of " +
    "languages, and the extension uses your own account for each one.",
};

/** The page whose selection scene 06 reads: any URL the browser can hold a
 *  selection on; the response is served by the scene itself. */
const ARTICLE_URL = "http://article.test/reading-the-web-with-your-ears";

/** The Sandbox scene's text: the article above, continued far enough to fill
 *  the text box at the popup's height. */
const SANDBOX_TEXT = [
  ARTICLE.title,
  ARTICLE.lede,
  ARTICLE.selected,
  ARTICLE.after,
  "Pick a voice once in Preferences and star the ones you like; the picker keeps them one " +
    "click away, and each row plays a short preview before you commit. " +
    "Speed and pitch are yours to set, and a slower pace makes dense technical writing easier to follow.",
  "The Sandbox is the place to try a passage before reading a whole page. " +
    "Paste anything here, press play, and skip back or forward fifteen seconds at a time. " +
    "The download button saves the same reading as an audio file for later.",
  "Your keys stay in your browser. " +
    "The text you read goes straight from the browser to the provider you picked, and to nobody else.",
].join("\n\n");

// --- The context menu page ------------------------------------------------------

interface ContextMenuScene {
  icon: string;
  /** The read-aloud items, in menu order. */
  items: string[];
  download: string;
  stop: string;
}

/** Put the menus where a right-click at the end of the selection's last
 *  line opens them: the main menu hangs from the pointer, just under that
 *  line, and the submenu sits beside the open item. Both stay inside the
 *  article's width.
 *  Positions come from the laid out page, so the menus follow the paragraph
 *  whatever font the host has. */
async function placeMenus(page: Page): Promise<void> {
  await page.evaluate(() => {
    const node = (selector: string) => {
      const found = document.querySelector<HTMLElement>(selector);
      if (!found) throw new Error(`${selector} is missing from the scene`);
      return found;
    };
    const selection = node(".selection");
    const lines = selection.getClientRects();
    const last = lines[lines.length - 1] ?? selection.getBoundingClientRect();
    const main = node(".main-menu");
    const sub = node(".sub-menu");
    const open = node(".item.open");
    const right = selection.getBoundingClientRect().right;
    main.style.left = `${Math.min(last.right - 24, right - main.offsetWidth - sub.offsetWidth + 6)}px`;
    main.style.top = `${last.bottom + 2}px`;
    sub.style.left = `${main.offsetLeft + main.offsetWidth - 6}px`;
    sub.style.top = `${main.offsetTop + open.offsetTop - 6}px`;
  });
}

function contextMenuScene(scene: ContextMenuScene): string {
  const item = (label: string) => `<li class="item">${label}</li>`;
  // Chrome trims the quoted selection to fit the menu's width.
  const search = `Search Google for "${ARTICLE.selected.slice(0, 22)}..."`;
  // The page is laid out in frame pixels, at a reading size larger than a
  // desktop article's natural one: the store crop shows it at about 2x more.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #fff; }
  body {
    font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1c1917; -webkit-font-smoothing: antialiased;
  }
  .bar { height: 68px; background: #f5f5f4; border-bottom: 1px solid #e7e5e4; }
  .bar .url {
    position: absolute; top: 17px; left: 192px; width: 876px; height: 34px;
    border-radius: 17px; background: #fff; border: 1px solid #e7e5e4;
    font-size: 16px; color: #78716c; line-height: 34px; padding-left: 17px;
  }
  main { max-width: 600px; margin: 64px auto 0; }
  .kicker { font-size: 15px; font-weight: 700; letter-spacing: 0.08em; color: #b45309; text-transform: uppercase; }
  h1 { font-size: 38px; line-height: 1.15; margin: 14px 0 24px; font-weight: 800; letter-spacing: -0.01em; }
  p { font-size: 20px; line-height: 1.6; margin: 0 0 26px; color: #292524; }
  .selection { background: #b4d5fe; color: #1c1917; }
  .menu {
    position: absolute; padding: 6px 0; margin: 0; list-style: none;
    background: #fff; border: 1px solid #d6d3d1; border-radius: 10px;
    box-shadow: 0 10px 28px rgba(0, 0, 0, 0.18); font-size: 15px; color: #1c1917;
  }
  .item {
    padding: 5px 14px 5px 40px; line-height: 20px; position: relative;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .item.open { background: #e7e5e4; }
  .item.parent::after {
    content: ""; position: absolute; right: 14px; top: 10px; border: 5px solid transparent;
    border-left-color: #57534e;
  }
  .item img { position: absolute; left: 12px; top: 6px; width: 18px; height: 18px; }
  .sep { height: 1px; margin: 5px 0; background: #e7e5e4; }
  .main-menu { width: 260px; }
  .sub-menu { width: 196px; }
</style>
</head>
<body>
  <div class="bar"><div class="url">example.org/reading-the-web-with-your-ears</div></div>
  <main>
    <div class="kicker">${ARTICLE.kicker}</div>
    <h1>${ARTICLE.title}</h1>
    <p class="lede">${ARTICLE.lede}</p>
    <p><span class="selection">${ARTICLE.selected}</span></p>
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
