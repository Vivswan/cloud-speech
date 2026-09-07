import { expect, test } from "@playwright/test";
import { type ExtensionSession, launchExtension } from "./fixtures";

// UI smoke: open the popup as a page and assert the core surfaces render. No
// provider credentials are needed; this covers the first-run experience end
// to end.

let extension: ExtensionSession;

test.beforeAll(async () => {
  extension = await launchExtension("cloud-speech-e2e-");
});

test.afterAll(async () => {
  await extension?.close();
});

test("popup renders the sidebar and sandbox", async () => {
  const page = await extension.openPopup();

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
  const page = await extension.openPopup();
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
  const page = await extension.openPopup();
  await page.getByRole("link", { name: "Preferences" }).click();

  await expect(page.getByText(/no voices yet/i).first()).toBeVisible();

  await page.close();
});

test("feedback view offers the GitHub issue actions", async () => {
  const page = await extension.openPopup();
  await page.getByRole("link", { name: "Feedback" }).click();

  await expect(page.getByRole("button", { name: /report a bug/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /request a feature/i })).toBeVisible();

  await page.close();
});

test("no popup console errors across the smoke", () => {
  // Benign network failures can't occur: no credentials were entered.
  expect(extension.consoleErrors).toEqual([]);
});
