import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_IDS, type ProviderId } from "@cloud-speech/constants";
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
//                   the labels it shows are large and sharp; the website's
//                   walkthrough frames show the same file
//   <scene>-2x.jpg  2560 x 1600, the whole composition for the website's
//                   lightbox and the README
//   crops.json      where each store crop sits in its -2x file, and the marker
//                   that a render finished
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

const EXTENSION_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const BUILD_DIR = join(EXTENSION_DIR, ".output/chrome-mv3");
const OUTPUT_DIR = join(EXTENSION_DIR, ".output/store-screenshots");
/** Written last, so its presence means the files beside it are one complete
 *  set (`bun run dev` and the website's dev server read it that way); a
 *  previous run's copy goes before the first scene overwrites an image. */
const CROPS_PATH = join(OUTPUT_DIR, "crops.json");

/** The composition's coordinate space, and the store file's size. */
const FRAME = { width: 1280, height: 800 };
/** Every composition is rendered at this device scale; the full file is that
 *  render as is, and the store file is a window over it. */
const RENDER_SCALE = 2;
const RENDER = { width: FRAME.width * RENDER_SCALE, height: FRAME.height * RENDER_SCALE };
/** The store crop's window, in frame pixels: the part of the render that
 *  fills the store file one render pixel per output pixel, so a popup CSS
 *  pixel is RENDER_SCALE output pixels there: a 12 px label lands at 24 px.
 *  Every store crop is exactly this window; a focus that does not fit in it
 *  fails its scene. */
const WINDOW = { width: FRAME.width / RENDER_SCALE, height: FRAME.height / RENDER_SCALE };
/** The popup's height: Chrome's popup cap, fixed in popup/index.html. Its
 *  width is auto within the bounds set there, measured per scene. */
const POPUP_HEIGHT = 600;
const CORNER_RADIUS = 14;

/** Canvas behind the popup; the popup's own page colors are stone-50/900. */
const CANVAS = { light: "#e7e5e4", dark: "#292524" } as const;
type Theme = keyof typeof CANVAS;

const OPENAI_API = "https://api.openai.com";
/** The one key api.openai.com rejects here: a request carrying it is answered
 *  the way OpenAI answers a rejected key, in its own words, and never reaches
 *  the fake server. Every other key is accepted. */
const OPENAI_REVOKED_KEY = "sk-store-screenshots-revoked";
const OPENAI_REJECTED_KEY = {
  error: {
    message: "Incorrect API key provided: sk-store***oked.",
    type: "invalid_request_error",
    code: "invalid_api_key",
  },
};
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
  rmSync(CROPS_PATH, { force: true });
  server = await startFakeSpeechServer();

  extension = await launchExtension("cloud-speech-store-screenshots-", {
    deviceScaleFactor: RENDER_SCALE,
    // The scenes locate English labels, so the browser is pinned to English
    // regardless of the host.
    locale: "en-US",
  });
  // Every OpenAI request the background makes is answered by the fake server
  // at the same path, so the OpenAI provider connects and reads like a real one.
  await extension.context.route(`${OPENAI_API}/**`, async (route) => {
    const request = route.request();
    if (request.headers().authorization === `Bearer ${OPENAI_REVOKED_KEY}`) {
      await route.fulfill({ status: 401, json: OPENAI_REJECTED_KEY });
      return;
    }
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

/** What a view shows once the reads that size it have answered, one element
 *  per read: the settings (the view's cards), the voices (the picker's tip,
 *  so the scenes open Preferences with a provider connected), and the
 *  sections with a read of their own (every provider row, the Backup card).
 *  Reads that only fill in text (the playback document, the shortcut
 *  bindings) move no layout and are not waited for. */
const VIEW_READY: Record<View, (page: Page) => Locator[]> = {
  Sandbox: (page) => [page.getByLabel("Text to speak"), page.getByRole("button", { name: /^P/ })],
  Preferences: (page) => [
    page.getByText(/^Tip:/),
    page.getByText("Keyboard shortcuts", { exact: true }),
  ],
  Settings: (page) => [
    ...PROVIDER_IDS.map((id) => page.getByTestId(`provider-${id}`)),
    page.getByRole("button", { name: "Export" }),
    page.getByText("Display language", { exact: true }),
  ],
};

async function openPopup(view: View): Promise<Page> {
  const page = await extension.openPopup();
  await page.getByRole("link", { name: view }).click();
  await fitPopup(page, view);
  return page;
}

/** The width Chrome gives the action popup: the document laid out at the
 *  lower bound, widened to its scroll width when the content overflows that,
 *  up to the upper bound. Not the content's preferred width: text wraps and
 *  truncates at the lower bound rather than widen the popup. Measured on the
 *  native popup of the Chromium the renderer runs in (chrome.action.openPopup
 *  from the service worker, the popup target read over CDP): every view opens
 *  at the lower bound, 600 px. */
async function chromeWidth(page: Page): Promise<number> {
  const bounds = await page.evaluate(() => {
    const style = getComputedStyle(document.body);
    return { min: parseFloat(style.minWidth), max: parseFloat(style.maxWidth) };
  });
  await page.setViewportSize({ width: bounds.min, height: POPUP_HEIGHT });
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  return Math.min(Math.max(scrollWidth, bounds.min), bounds.max);
}

/** Size the page the way Chrome sizes the action popup: chromeWidth by the
 *  popup's fixed height, which is checked against the page. Called when a view opens and again after a scene changes what the
 *  view shows (a card expands, a banner appears): Chrome resizes the popup
 *  to its content, so the width is the content's at the moment of the shot,
 *  and capturePopup fails a scene whose popup is not.
 *  The layout the width comes from must be complete first: the view fills in
 *  over several reads, each arriving on its own, and the bundled typefaces
 *  swap in once text first uses them; each reflows the view, so a width, a
 *  scroll, or a box taken before them is wrong once they happen. So the
 *  view's reads are waited for (VIEW_READY), the faces are loaded, and the
 *  view gets until its size and its element count have held still, before
 *  and after the resize. */
async function fitPopup(page: Page, view: View): Promise<void> {
  for (const ready of VIEW_READY[view](page)) await ready.waitFor();
  await page.evaluate(async () => {
    await Promise.all([...document.fonts].map((face) => face.load()));
    await document.fonts.ready;
  });
  await heldStill(page);
  await page.setViewportSize({ width: await chromeWidth(page), height: POPUP_HEIGHT });
  await heldStill(page);
  const height = await page.evaluate(() => document.documentElement.getBoundingClientRect().height);
  expect(height, "the popup card is POPUP_HEIGHT tall").toBe(POPUP_HEIGHT);
}

/** Resolve once the view's size and the document's element count have been
 *  the same for three samples 100 ms apart, within 10 s; otherwise fail,
 *  naming what last changed and its last two readings. */
async function heldStill(page: Page): Promise<void> {
  const moving = await scrollBox(page).evaluate(async (view) => {
    const sample = () => ({
      height: view.scrollHeight,
      nodes: document.querySelectorAll("*").length,
    });
    const deadline = Date.now() + 10_000;
    let last = sample();
    let change = `first reading ${JSON.stringify(last)}`;
    for (let held = 0; held < 3; ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const next = sample();
      if (next.height === last.height && next.nodes === last.nodes) {
        held += 1;
      } else {
        held = 0;
        const what = next.height === last.height ? "element count" : "scrollHeight";
        change = `${what} changed: ${JSON.stringify(last)} then ${JSON.stringify(next)}`;
      }
      last = next;
      if (Date.now() > deadline) return `not still within 10 s; last ${change}`;
    }
    return null;
  });
  expect(moving, "the view held still").toBeNull();
}

/** The view's scroll box: the one scrollable element of a view taller than
 *  the popup. */
function scrollBox(page: Page) {
  return page.locator("[class*=overflow-y-auto]");
}

/** Scroll the view to its start or its end, the way a user reaches the top or
 *  the bottom of a view taller than the popup. */
async function scrollView(page: Page, edge: "start" | "end"): Promise<void> {
  await scrollBox(page).evaluate((node, edge) => {
    node.scrollTop = edge === "start" ? 0 : node.scrollHeight;
  }, edge);
}

/** Scroll the view by `offset` CSS pixels from where it is, and check it got
 *  there: a view too short to scroll that far would leave the crop's edges
 *  on other lines than the ones placed. */
async function scrollViewBy(page: Page, offset: number): Promise<void> {
  const scrolled = await scrollBox(page).evaluate((node, offset) => {
    const target = node.scrollTop + offset;
    node.scrollTop = target;
    return node.scrollTop - target;
  }, offset);
  expect(Math.abs(scrolled), `the view scrolled by ${offset} px`).toBeLessThan(1);
}

function providerRow(page: Page, id: ProviderId, name: string) {
  const row = page.getByTestId(`provider-${id}`);
  return {
    row,
    header: row.getByText(name, { exact: true }),
    /** The status chip; the row's summary line can carry the same word. */
    chip: (status: "Connected" | "Off" | "Not connected") =>
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

/** The language select, whose bottom border is the picker window's top edge. */
function languageSelect(page: Page) {
  return page.getByText("Voice language", { exact: true }).locator("..").getByRole("combobox");
}

/** Scroll Preferences so the picker window's edges miss the sidebar's labels:
 *  its top edge, the language select's bottom border, lands between the
 *  sidebar's subtitle and its first item, and its bottom edge then falls in
 *  the sidebar's empty middle, above the theme button. */
async function scrollForPicker(page: Page): Promise<void> {
  const language = await boxOf(languageSelect(page));
  const subtitle = await boxOf(page.getByText("Text to speech", { exact: true }));
  const first = await boxOf(page.getByRole("link", { name: "Sandbox" }));
  const between = (subtitle.y + subtitle.height + first.y) / 2;
  await scrollViewBy(page, language.y + language.height - between);
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

/** The picker scenes' focus: the Voice field with the open picker under it
 *  (the search box, the chips row, and the five favorite rows), in the
 *  popup's CSS pixels. The window starts at the language select's bottom
 *  border and ends, below the picker, above the Keyboard shortcuts heading,
 *  past the Appearance card's bottom corner; it is the picker's width, and
 *  Preferences is narrower than the window, so the crop shows the popup's
 *  whole width, the sidebar and the card headings beside the picker included. */
async function pickerFocus(page: Page): Promise<Focus> {
  const language = await boxOf(languageSelect(page));
  // The open picker's trigger; the rows in the popover carry the name too.
  const trigger = await boxOf(page.getByRole("button", { name: /^Nova/, expanded: true }));
  const picker = await boxOf(page.getByRole("dialog"));
  const top = language.y + language.height;
  const bottom = top + WINDOW.height;
  // The Voice label floats 8 px above the field's top edge.
  expect(trigger.y - 8, "the field's floating label is in the window").toBeGreaterThan(top + 2);
  expect(picker.y + picker.height, "the picker is in the window").toBeLessThan(bottom - 4);
  const appearance = await boxOf(
    page.getByText("Appearance", { exact: true }).locator("..").locator("> div").last(),
  );
  expect(appearance.y + appearance.height, "the Appearance card ends in the window").toBeLessThan(
    bottom - 2,
  );
  const next = await boxOf(page.getByText("Keyboard shortcuts", { exact: true }));
  expect(next.y, "the window ends above the Keyboard shortcuts heading").toBeGreaterThanOrEqual(
    bottom,
  );
  return windowFrom(picker, top);
}

/** The y, in the popup's CSS pixels, of the boundary between two lines of the
 *  text box next to `y`: the last one at or above it, or the first one at or
 *  below it. A crop edge placed there cuts the text between two lines, never
 *  through one. */
async function lineBoundary(
  textarea: Locator,
  y: number,
  side: "above" | "below",
): Promise<number> {
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
  const firstLine = box.y + inset;
  const lines = (y - firstLine) / lineHeight;
  return firstLine + (side === "above" ? Math.floor(lines) : Math.ceil(lines)) * lineHeight;
}

/** Frame pixels of backdrop a window shows at least when it reaches past the
 *  card's top or bottom edge: enough for the edge and its corners to read as
 *  the card's. */
const EDGE_MARGIN = 12;

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
 *  still sliding in would place the crop a few pixels off. An animation
 *  cancelled on the way (a transition its element left) has nothing left to
 *  wait for, so its rejection counts as finished. */
async function boxOf(locator: Locator): Promise<Box> {
  await locator.page().evaluate(() =>
    Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => undefined)),
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

/** The focus of a window as tall as WINDOW whose top edge is `top`, over
 *  `column`, what it must show whole across. */
function windowFrom(column: Box, top: number): Focus {
  return {
    fit: { x: column.x, y: top, width: column.width, height: WINDOW.height },
    pad: 0,
    anchor: "top",
  };
}

/** The store crop's window: WINDOW, placed so the padded fit sits at its
 *  anchor, in the fit's coordinates. A fit that does not fit the window is an
 *  error, never scaled down to it: a scene that placed its edge on a line or
 *  a card corner would silently lose it. */
function placeWindow(name: string, { fit, pad, anchor }: Focus): Box {
  const padded = {
    x: fit.x - pad,
    y: fit.y - pad,
    width: fit.width + 2 * pad,
    height: fit.height + 2 * pad,
  };
  if (padded.width > WINDOW.width || padded.height > WINDOW.height) {
    throw new Error(
      `${name}'s focus ${JSON.stringify(padded)} does not fit the ` +
        `${WINDOW.width} x ${WINDOW.height} store window (pad ${pad})`,
    );
  }
  const { width, height } = WINDOW;
  const x = padded.x + (padded.width - width) / 2;
  const y =
    anchor === "top"
      ? padded.y
      : anchor === "bottom"
        ? padded.y + padded.height - height
        : padded.y + (padded.height - height) / 2;
  return { x, y, width, height };
}

/** The store crop's window in frame pixels. A window that leaves the frame is
 *  an error, never moved back in, for the same reason a fit is never scaled. */
function storeWindow(name: string, focus: Focus): Box {
  const window = placeWindow(name, focus);
  const { x, y, width, height } = window;
  if (x < 0 || y < 0 || x + width > FRAME.width || y + height > FRAME.height) {
    throw new Error(
      `${name}'s store window ${JSON.stringify(window)} leaves the ` +
        `${FRAME.width} x ${FRAME.height} frame (anchor ${focus.anchor}, pad ${focus.pad})`,
    );
  }
  return window;
}

/** The lines of text the window's top or bottom edge would cut through, in
 *  the page: every rendered line of every text node under the window's
 *  columns whose box straddles one of the edges. A crop cuts between lines,
 *  never through one, wherever the edge falls (the sidebar included), so a
 *  scene whose window does is staged again, not shipped. */
async function linesCutBy(page: Page, window: Box): Promise<string[]> {
  return page.evaluate(({ x, y, width, height }) => {
    const edges = [y, y + height];
    const cut: string[] = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of range.getClientRects()) {
        if (rect.width === 0 || rect.height === 0) continue;
        if (rect.right <= x || rect.left >= x + width) continue;
        for (const edge of edges) {
          if (rect.top < edge - 0.5 && rect.bottom > edge + 0.5) {
            cut.push(
              `"${node.textContent.trim().slice(0, 40)}" (${rect.top}..${rect.bottom}) at ${edge}`,
            );
          }
        }
      }
    }
    return cut;
  }, window);
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
 *  pixel, so its edges stay sharp in the store crops too. */
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
  // The shadow's tail (12 px of blur and a 6 px offset) fades well within the
  // margin below the card, so the frame's edge never cuts a visible shadow.
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
    toFrame: (box) => ({ ...box, x: left / RENDER_SCALE + box.x, y: top / RENDER_SCALE + box.y }),
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

/** Both files of a scene from its composition: the render as the full file,
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

  const fullPath = join(OUTPUT_DIR, `${name}-2x.jpg`);
  await sharp(render).flatten({ background: CANVAS[theme] }).jpeg(jpeg).toFile(fullPath);
  await expectJpeg(fullPath, RENDER);

  const window = storeWindow(name, { ...focus, fit: composition.toFrame(focus.fit) });
  const region = {
    left: Math.round(window.x * RENDER_SCALE),
    top: Math.round(window.y * RENDER_SCALE),
    width: Math.round(window.width * RENDER_SCALE),
    height: Math.round(window.height * RENDER_SCALE),
  };
  // The window, pixel for pixel: it is FRAME-sized by construction, and
  // expectJpeg below holds the file to that.
  const storePath = join(OUTPUT_DIR, `${name}.jpg`);
  await sharp(render)
    .extract(region)
    .flatten({ background: CANVAS[theme] })
    .jpeg(jpeg)
    .toFile(storePath);
  await expectJpeg(storePath, FRAME);
  crops.push({
    scene: name,
    store: `${name}.jpg`,
    full: `${name}-2x.jpg`,
    size: { ...RENDER },
    window: region,
  });
  console.log(`${name}: store crop at (${Math.round(window.x)}, ${Math.round(window.y)})`);
}

async function expectJpeg(path: string, size: { width: number; height: number }): Promise<void> {
  const { width, height, channels, format } = await sharp(path).metadata();
  expect({ width, height, channels, format }, `${path} is an RGB JPEG of the right size`).toEqual({
    ...size,
    channels: 3,
    format: "jpeg",
  });
}

/** The scene's popup as its files: the page, whose content must not overflow
 *  the width fitPopup gave it (a scene that widened the view since then, so
 *  Chrome would have widened the popup, fails here rather than ship it),
 *  framed on the canvas, with the store window over the focus. A popup
 *  narrower than the window is shown whole: the window is centered on the
 *  card, not on the focus. */
async function capturePopup(page: Page, name: string, theme: Theme, focus: Focus): Promise<void> {
  const card = await boxOf(page.locator("html"));
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(scrollWidth, `${name}'s content fits the popup's width`).toBeLessThanOrEqual(card.width);
  const fit =
    card.width <= WINDOW.width ? { ...focus.fit, x: card.x, width: card.width } : focus.fit;
  const placed = { ...focus, fit };
  const cut = await linesCutBy(page, placeWindow(name, placed));
  expect(cut, `${name}'s window edges cut through no line of text`).toEqual([]);
  const popup = await page.screenshot({ type: "png", animations: "disabled" });
  await writeScene(name, await framePopup(popup, theme), theme, placed);
}

// --- Scenes -------------------------------------------------------------------------
// Numbered like their files (the order in docs/store-listing.md); scene 09 runs
// first because its provider must still be unconnected.

test("09 settings: a Save & test that fails on a rejected key", async () => {
  const page = await openPopup("Settings");
  const openai = providerRow(page, "openai", "OpenAI");
  await openai.header.click();
  await openai.row.getByLabel("API Key").fill(OPENAI_REVOKED_KEY);
  await openai.row.getByRole("button", { name: "Save & test" }).click();
  // The verdict: a title, the one sentence to act on, and the technical
  // reason behind a collapsed Details.
  const verdict = openai.row.getByRole("alert");
  await expect(verdict.getByText("Key rejected", { exact: true })).toBeVisible();
  await expect(verdict.getByText("Re-copy the key and try again.", { exact: true })).toBeVisible();
  await expect(verdict.locator("summary")).toHaveText("Details");
  await expect(verdict.locator("details")).not.toHaveAttribute("open");
  await expect(openai.chip("Not connected")).toBeVisible();
  await fitPopup(page, "Settings");
  // The failed test scrolled the view to its button; back at the top, the
  // rows around the failed card are in view, the card's verdict reaching the
  // card's bottom edge.
  await scrollView(page, "start");
  // The window starts in the gap above the Google Cloud TTS row and reaches
  // down past the card's bottom edge: the row above the failed card, the card
  // with its verdict, and the card's bottom corners.
  const card = await boxOf(page.locator("html"));
  const google = await boxOf(providerRow(page, "google", "Google Cloud TTS").row);
  const above = await boxOf(providerRow(page, "azure", "Azure Speech").row);
  const top = (above.y + above.height + google.y) / 2;
  expect(top + WINDOW.height, "the window reaches past the card's bottom edge").toBeGreaterThan(
    card.y + card.height + EDGE_MARGIN,
  );
  await capturePopup(page, "09-settings-save-test-error", "light", windowFrom(google, top));
  await page.close();
});

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
  await scrollForPicker(page);

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
  // is the first one that keeps the window's bottom at least EDGE_MARGIN
  // below the card, so the crop shows up to a line more of the backdrop.
  const card = await boxOf(page.locator("html"));
  const player = await boxOf(pause.locator(".."));
  const textarea = page.getByLabel("Text to speak");
  const bottom = card.y + card.height + EDGE_MARGIN;
  const top = await lineBoundary(textarea, bottom - WINDOW.height, "below");
  await capturePopup(page, "04-sandbox-player", "light", windowFrom(player, top));
  await pause.click();
  await page.close();
});

test("03 settings: the provider accordion", async () => {
  const page = await openPopup("Settings");
  const openai = providerRow(page, "openai", "OpenAI");
  await openai.header.click();
  await expect(openai.row.getByRole("button", { name: "Save & test" })).toBeVisible();
  await fitPopup(page, "Settings");
  // The window reaches from above the card's top edge down into the gap
  // under the expanded OpenAI card: the Providers heading, the rows above the
  // card, and the card itself. The view is scrolled the few pixels that put
  // the gap at the window's bottom edge.
  const card = await boxOf(page.locator("html"));
  const bottom = card.y - EDGE_MARGIN + WINDOW.height;
  const expanded = await boxOf(openai.row);
  const below = await boxOf(
    page.getByTestId(`provider-${PROVIDER_IDS[PROVIDER_IDS.indexOf("openai") + 1]}`),
  );
  await scrollViewBy(page, (expanded.y + expanded.height + below.y) / 2 - bottom);
  const column = await boxOf(openai.row);
  await capturePopup(
    page,
    "03-settings-providers",
    "light",
    windowFrom(column, card.y - EDGE_MARGIN),
  );
  await page.close();
});

test("05 preferences in the dark theme", async () => {
  const page = await openPopup("Preferences");
  await page.getByRole("combobox").filter({ hasText: "System" }).click();
  await page.getByRole("option", { name: "Dark" }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await scrollForPicker(page);
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
  const banner = page.getByRole("button", { name: "Use selection" }).locator("..");
  await expect(banner).toBeVisible();
  const pause = page.getByRole("button", { name: "Pause" });
  await expect(pause).toBeVisible();
  await fitPopup(page, "Sandbox");
  // The text box holds the article again (the popup came back with the
  // default line), so the crop shows text under the banner, not an empty box.
  const textarea = page.getByLabel("Text to speak");
  await textarea.fill(SANDBOX_TEXT);
  // The fill left the caret, and the box's scroll, at the text's end.
  await textarea.evaluate((node) => node.scrollTo(0, 0));
  // The window reaches from above the card's top edge down to a line boundary
  // of the text box: the corners, the title, the banner, and the text's
  // first lines, cut between two lines. The boundary is the last one that
  // keeps the window's top at least EDGE_MARGIN above the card, so the crop
  // shows up to a line more of the backdrop.
  const card = await boxOf(page.locator("html"));
  const column = await boxOf(banner);
  const bottom = await lineBoundary(textarea, card.y - EDGE_MARGIN + WINDOW.height, "above");
  await capturePopup(
    page,
    "06-sandbox-reading-page",
    "light",
    windowFrom(column, bottom - WINDOW.height),
  );
  await pause.click();
  await article.close();
  await page.close();
});

test("07 preferences: the voice and its prosody controls", async () => {
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
  await fitPopup(page, "Preferences");
  // The Voice & prosody card whole, from the language select to the style
  // select. The card is a few pixels too tall for the popup's top edge to fit
  // in the window as well, so the view is scrolled until the card's heading
  // has just left it (the heading is what the card is called) and the window
  // starts in the gap between the heading and the card's top border, at the
  // sidebar's top padding, and ends in the gap between the card and the
  // Audio format heading.
  const section = page.getByText("Voice & prosody", { exact: true }).locator("..");
  const heading = await boxOf(section.getByText("Voice & prosody", { exact: true }));
  await scrollViewBy(page, heading.y + heading.height);
  const prosody = await boxOf(section.locator("> div").last());
  const next = await boxOf(page.getByText("Audio format", { exact: true }));
  const logo = await boxOf(page.getByText("Cloud Speech", { exact: true }));
  const top = prosody.y - 4;
  const bottom = top + WINDOW.height;
  expect(top, "the window starts inside the popup").toBeGreaterThanOrEqual(0);
  expect(top, "the window starts above the sidebar's logo").toBeLessThanOrEqual(logo.y);
  expect(prosody.y + prosody.height, "the window ends under the card").toBeLessThan(bottom - 2);
  expect(next.y, "the window ends above the Audio format heading").toBeGreaterThanOrEqual(bottom);
  await capturePopup(page, "07-preferences-prosody", "light", windowFrom(prosody, top));
  await page.close();
});

test("08 settings: sync and backup", async () => {
  const page = await openPopup("Settings");
  // Scrolled to its end, the view shows the Sync card (on, saved to the
  // browser account), the Backup card, and the language card above the
  // card's bottom edge. The window reaches down past the card's bottom edge
  // and starts in the gap between the last provider row and the Sync heading.
  await scrollView(page, "end");
  await expect(page.getByRole("switch", { name: /^Sync settings/ })).toBeChecked();
  const card = await boxOf(page.locator("html"));
  const heading = page.getByText("Sync", { exact: true });
  const sync = await boxOf(heading);
  const lastRow = await boxOf(
    page.getByTestId(`provider-${PROVIDER_IDS[PROVIDER_IDS.length - 1]}`),
  );
  const top = card.y + card.height + EDGE_MARGIN - WINDOW.height;
  expect(top, "the window starts above the Sync heading").toBeLessThanOrEqual(sync.y);
  expect(top, "the window starts below the last provider row").toBeGreaterThanOrEqual(
    lastRow.y + lastRow.height,
  );
  const column = await boxOf(heading.locator(".."));
  await capturePopup(page, "08-settings-sync", "light", windowFrom(column, top));
  await page.close();
});

test("10 preferences: the formats, the theme, and the shortcuts", async () => {
  const page = await openPopup("Preferences");
  // Scrolled to its end, the view shows the Audio format, Appearance, and
  // Keyboard shortcuts cards above the card's bottom edge. The window starts
  // in the gap above the Audio format heading and reaches down past the
  // card's bottom edge.
  await scrollView(page, "end");
  const card = await boxOf(page.locator("html"));
  const heading = page.getByText("Audio format", { exact: true });
  const top = (await boxOf(heading)).y - EDGE_MARGIN;
  const column = await boxOf(heading.locator(".."));
  expect(top + WINDOW.height, "the window reaches past the card's bottom edge").toBeGreaterThan(
    card.y + card.height + EDGE_MARGIN,
  );
  await capturePopup(page, "10-preferences-shortcuts", "light", windowFrom(column, top));
  await page.close();
});

// Last: in serial mode a failed scene stops the run here, so a partial
// crops.json is never written (and the previous run's is already gone).
// Sorted by scene, the order of the files and of docs/store-listing.md,
// whatever order the scenes ran in.
test("crops.json: where each store crop sits in its full render", () => {
  const sorted = [...crops].sort((a, b) => a.scene.localeCompare(b.scene));
  writeFileSync(CROPS_PATH, `${JSON.stringify(sorted, null, 2)}\n`);
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
