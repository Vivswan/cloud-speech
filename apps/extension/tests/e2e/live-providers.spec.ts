import { expect, type Locator, type Page, test } from "@playwright/test";
import { providerStatus } from "./assertions";
import { type ExtensionSession, launchExtension } from "./fixtures";

const LIVE_TESTS_ENABLED = process.env.LIVE_PROVIDER_TESTS === "1";

let extension: ExtensionSession;

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

async function openSettings(): Promise<Page> {
  const page = await extension.openPopup();
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
  await expect(providerStatus(row, "Connected")).toBeVisible({ timeout: 120_000 });
  await expect(row.getByText(/[1-9]\d* voices/)).toBeVisible();
}

interface CredentialField {
  readonly label: string;
  readonly env: string;
  /** Filled when the variable is unset; a field with neither this nor `optional` skips the test. */
  readonly fallback?: string;
  /** Left empty when the variable is unset. */
  readonly optional?: true;
}

interface LiveProvider {
  readonly id: string;
  readonly name: string;
  readonly fields: readonly CredentialField[];
}

const LIVE_PROVIDERS: readonly LiveProvider[] = [
  {
    id: "azure",
    name: "Azure Speech",
    fields: [
      { label: "Subscription Key", env: "AZURE_API_KEY" },
      { label: "Region", env: "AZURE_REGION", fallback: "eastus" },
    ],
  },
  {
    id: "polly",
    name: "Amazon Polly",
    fields: [
      { label: "Access Key ID", env: "AWS_ACCESS_KEY_ID" },
      { label: "Secret Access Key", env: "AWS_SECRET_ACCESS_KEY" },
      { label: "Region", env: "AWS_REGION", fallback: "us-east-1" },
    ],
  },
  {
    id: "google",
    name: "Google Cloud TTS",
    fields: [{ label: "API Key", env: "GCP_API_KEY" }],
  },
  {
    id: "openai",
    name: "OpenAI",
    fields: [{ label: "API Key", env: "OPENAI_API_KEY" }],
  },
  {
    id: "custom",
    name: "OpenAI-compatible",
    fields: [
      { label: "Server URL", env: "OPENAI_COMPATIBLE_BASE_URL" },
      { label: "API key (optional)", env: "OPENAI_COMPATIBLE_API_KEY", optional: true },
      {
        label: "Voice names, comma-separated (optional)",
        env: "OPENAI_COMPATIBLE_VOICES",
        optional: true,
      },
      {
        label: "Models, comma-separated (optional)",
        env: "OPENAI_COMPATIBLE_MODEL",
        optional: true,
      },
    ],
  },
];

test.describe("live provider validation", () => {
  test.skip(!LIVE_TESTS_ENABLED, "Set LIVE_PROVIDER_TESTS=1 to call real providers");

  test.beforeAll(async () => {
    extension = await launchExtension("cloud-speech-live-e2e-");
  });

  test.afterAll(async () => {
    await extension?.close();
  });

  // Each provider skips on its own missing credentials, so a partial .env still exercises what it can.
  for (const provider of LIVE_PROVIDERS) {
    test(`connects ${provider.name}`, async () => {
      const missing = provider.fields
        .filter((field) => field.fallback === undefined && !field.optional && !env(field.env))
        .map((field) => field.env);
      test.skip(missing.length > 0, `${missing.join(" / ")} not set`);
      test.setTimeout(240_000);

      const page = await openSettings();
      const row = await openProviderRow(page, provider.id, provider.name);
      for (const field of provider.fields) {
        const value = env(field.env) ?? field.fallback;
        if (value !== undefined) await row.getByLabel(field.label).fill(value);
      }
      await saveAndExpectConnected(row);
      await page.close();
    });
  }
});
