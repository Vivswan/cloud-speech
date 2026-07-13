import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type BrowserContext,
  chromium,
  expect,
  type Locator,
  type Page,
  test,
} from "@playwright/test";

const LIVE_TESTS_ENABLED = process.env.LIVE_PROVIDER_TESTS === "1";
const EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../.output/chrome-mv3");

let context: BrowserContext;
let extensionId: string;
let userDataDir: string;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function openSettings(): Promise<Page> {
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.getByRole("link", { name: "Settings" }).click();
  return page;
}

async function openProviderRow(page: Page, providerId: string, name: string): Promise<Locator> {
  const row = page.getByTestId(`provider-${providerId}`);
  await row.getByText(name, { exact: true }).click();
  return row;
}

async function saveAndExpectConnected(row: Locator): Promise<void> {
  await row.getByRole("button", { name: "Save & test" }).click();
  await expect(row.getByText("Connected", { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect(row.getByText(/[1-9]\d* voices/)).toBeVisible();
}

test.describe("live provider validation", () => {
  test.skip(!LIVE_TESTS_ENABLED, "Set LIVE_PROVIDER_TESTS=1 to call real providers");

  test.beforeAll(async () => {
    userDataDir = mkdtempSync(join(tmpdir(), "cloud-speech-live-e2e-"));
    context = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      headless: true,
      args: [`--disable-extensions-except=${EXTENSION_PATH}`, `--load-extension=${EXTENSION_PATH}`],
    });

    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent("serviceworker");
    extensionId = new URL(worker.url()).host;
  });

  test.afterAll(async () => {
    await context?.close();
    if (userDataDir) rmSync(userDataDir, { recursive: true, force: true });
  });

  // Each provider test runs only when its credentials are in the environment
  // and skips otherwise, so a partial .env still exercises what it can.

  test("connects Azure Speech", async () => {
    const key = env("AZURE_API_KEY");
    test.skip(!key, "AZURE_API_KEY not set");
    if (!key) return;
    test.setTimeout(240_000);

    const page = await openSettings();
    const row = await openProviderRow(page, "azure", "Azure Speech");
    await row.getByLabel("Subscription Key").fill(key);
    await row.getByLabel("Region").fill(env("AZURE_REGION") ?? "eastus");
    await saveAndExpectConnected(row);
    await page.close();
  });

  test("connects Amazon Polly", async () => {
    const keyId = env("AWS_ACCESS_KEY_ID");
    const secret = env("AWS_SECRET_ACCESS_KEY");
    test.skip(!keyId || !secret, "AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY not set");
    if (!keyId || !secret) return;
    test.setTimeout(240_000);

    const page = await openSettings();
    const row = await openProviderRow(page, "polly", "Amazon Polly");
    await row.getByLabel("Access Key ID").fill(keyId);
    await row.getByLabel("Secret Access Key").fill(secret);
    await row.getByLabel("Region").fill(env("AWS_REGION") ?? "us-east-1");
    await saveAndExpectConnected(row);
    await page.close();
  });

  test("connects Google Cloud TTS", async () => {
    const key = env("GCP_API_KEY");
    test.skip(!key, "GCP_API_KEY not set");
    if (!key) return;
    test.setTimeout(240_000);

    const page = await openSettings();
    const row = await openProviderRow(page, "google", "Google Cloud TTS");
    await row.getByLabel("API Key").fill(key);
    await saveAndExpectConnected(row);
    await page.close();
  });

  test("connects OpenAI", async () => {
    const key = env("OPENAI_API_KEY");
    test.skip(!key, "OPENAI_API_KEY not set");
    if (!key) return;
    test.setTimeout(240_000);

    const page = await openSettings();
    const row = await openProviderRow(page, "openai", "OpenAI");
    await row.getByLabel("API Key").fill(key);
    await saveAndExpectConnected(row);
    await page.close();
  });

  test("connects an OpenAI-compatible server", async () => {
    const baseUrl = env("OPENAI_COMPATIBLE_BASE_URL");
    test.skip(!baseUrl, "OPENAI_COMPATIBLE_BASE_URL not set");
    if (!baseUrl) return;
    test.setTimeout(240_000);

    const page = await openSettings();
    const row = await openProviderRow(page, "custom", "OpenAI-compatible");
    await row.getByLabel("Server URL").fill(baseUrl);
    const apiKey = env("OPENAI_COMPATIBLE_API_KEY");
    if (apiKey) await row.getByLabel("API key (optional)").fill(apiKey);
    const voices = env("OPENAI_COMPATIBLE_VOICES");
    if (voices) await row.getByLabel("Voice names, comma-separated (optional)").fill(voices);
    const model = env("OPENAI_COMPATIBLE_MODEL");
    if (model) await row.getByLabel("Models, comma-separated (optional)").fill(model);
    await saveAndExpectConnected(row);
    await page.close();
  });
});
