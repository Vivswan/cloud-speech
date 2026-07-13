import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, expect, test } from "@playwright/test";

// UI smoke: load the BUILT extension (chrome-mv3) into a real Chromium,
// open the popup as a page, and assert the core surfaces render. No provider
// credentials are needed — this covers the first-run experience end to end.
// Build first: `bun run build` (the root `test:e2e` script does).

const EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../.output/chrome-mv3");

let context: BrowserContext;
let extensionId: string;
let userDataDir: string;
const consoleErrors: string[] = [];

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), "cloud-speech-e2e-"));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: "chromium",
    // Extensions require the NEW headless mode (Playwright's chromium channel).
    headless: true,
    args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
  });

  // The MV3 service worker's origin carries the extension id.
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent("serviceworker");
  extensionId = new URL(worker.url()).host;
});

test.afterAll(async () => {
  await context?.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

async function openPopup() {
  const page = await context.newPage();
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  return page;
}

test("popup renders the sidebar and sandbox", async () => {
  const page = await openPopup();

  await expect(page.getByRole("link", { name: "Sandbox" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Preferences" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Feedback" })).toBeVisible();

  // Sandbox is the initial route: textarea + the player bar's controls.
  await expect(page.locator("textarea")).toBeVisible();
  await expect(page.getByRole("button", { name: /play/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /download/i })).toBeVisible();

  await page.close();
});

test("settings lists all four providers with the first-run banner", async () => {
  const page = await openPopup();
  await page.getByRole("link", { name: "Settings" }).click();

  for (const provider of ["Amazon Polly", "Azure Speech", "Google Cloud TTS", "OpenAI"]) {
    await expect(page.getByText(provider, { exact: true })).toBeVisible();
  }
  // First-run empty state (no credentials configured in a fresh profile).
  await expect(page.getByText(/connect a provider to begin/i)).toBeVisible();
  // Sync toggle present and on by default.
  await expect(page.getByText(/sync settings across my browsers/i)).toBeVisible();

  // A provider row expands to its credential fields with Save & test.
  await page.getByText("Amazon Polly", { exact: true }).click();
  await expect(page.getByRole("button", { name: /save & test/i })).toBeVisible();

  await page.close();
});

test("preferences shows the voice picker in its empty state", async () => {
  const page = await openPopup();
  await page.getByRole("link", { name: "Preferences" }).click();

  await expect(page.getByText(/no voices yet/i).first()).toBeVisible();

  await page.close();
});

test("feedback view offers the GitHub issue actions", async () => {
  const page = await openPopup();
  await page.getByRole("link", { name: "Feedback" }).click();

  await expect(page.getByRole("button", { name: /report a bug/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /request a feature/i })).toBeVisible();

  await page.close();
});

test("no console errors across the smoke", () => {
  // Benign network failures can't occur — no credentials were entered.
  expect(consoleErrors).toEqual([]);
});
