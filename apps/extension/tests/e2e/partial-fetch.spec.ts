import { expect, type Page, test } from "@playwright/test";
import type { RouteId } from "../../src/lib/protocol";
import type { Settings } from "../../src/lib/storage";
import { type FakeSpeechServer, startFakeSpeechServer } from "./fake-provider/server";
import { background, type ExtensionSession, launchExtension } from "./fixtures";

// The selected voice's provider fails its fetch with nothing of it cached, as every fetch after a browser restart faces (the
// session cache starts empty). The selection must wait for the provider, not move to a voice another provider offers.
//   failing provider   -> the fake server, closed for the outage and reopened at the same port
//   answering provider -> OpenAI: its voice list is static and needs no network, so a never-validated key suffices
//   the steps          -> one browser profile, in order

const KEY = "fake-key";
const MODEL = "tts-1";
const PICKED = { providerId: "custom", voiceId: "beta", model: MODEL };

test.describe.configure({ mode: "serial" });

/** The fake server while it listens; undefined during the outage. */
let server: FakeSpeechServer | undefined;
/** The port the server listened on, where the extension expects it back. */
let port: number;
let extension: ExtensionSession;

function listening(): FakeSpeechServer {
  if (!server) throw new Error("the fake server is closed");
  return server;
}

test.beforeAll(async () => {
  server = await startFakeSpeechServer();
  port = Number(new URL(server.origin).port);
  extension = await launchExtension("cloud-speech-partial-fetch-e2e-");
});

test.afterAll(async () => {
  try {
    await extension?.close();
  } finally {
    await server?.close();
  }
});

declare const chrome: {
  storage: {
    sync: {
      get(key: string): Promise<Record<string, unknown>>;
      set(items: Record<string, unknown>): Promise<void>;
    };
    session: { remove(key: string): Promise<void> };
  };
  runtime: { sendMessage(message: unknown): Promise<unknown> };
};

async function settings(): Promise<Settings> {
  const worker = await background(extension);
  const stored = await worker.evaluate(() => chrome.storage.sync.get("settings"));
  return stored.settings as Settings;
}

/** Awaited to its reply: the one barrier that says the handler has finished. */
function request(page: Page, id: RouteId<"background">): Promise<unknown> {
  return page.evaluate((id) => chrome.runtime.sendMessage({ to: "background", id }), id);
}

/** The selected voice's name (its id stands in while its provider is unreachable), or the placeholder with nothing selected. */
function pickerTrigger(page: Page) {
  return page.getByRole("button", { name: /^(beta|alpha|No voices yet)/ });
}

test("Save & test connects the fake server and the second voice is picked by hand", async () => {
  const page = await extension.openPopup();
  await page.getByRole("link", { name: "Settings" }).click();
  const row = page.getByTestId("provider-custom");
  await row.getByText("OpenAI-compatible", { exact: true }).click();
  await row.getByLabel("Server URL").fill(`${listening().origin}/v1`);
  await row.getByLabel("API key (optional)").fill(KEY);
  await row.getByRole("button", { name: "Save & test" }).click();
  await expect(row.getByText("Connected", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Preferences" }).click();
  await page.getByRole("button", { name: /^alpha/ }).click();
  await page.getByRole("button", { name: /^beta/ }).click();
  await expect(page.getByRole("button", { name: /^beta/ })).toBeVisible();
  await expect.poll(async () => (await settings()).selection).toEqual(PICKED);
  await page.close();
});

test("the selected provider failing with nothing cached keeps the selection", async () => {
  const worker = await background(extension);
  await worker.evaluate(async () => {
    const stored = await chrome.storage.sync.get("settings");
    const current = stored.settings as Settings;
    current.perProvider.openai = {
      credentials: { apiKey: "sk-test" },
      verified: false,
      enabled: true,
    };
    await chrome.storage.sync.set({ settings: current });
  });
  const before = await settings();
  expect(before.selection).toEqual(PICKED);

  // The outage, and the empty cache a browser restart leaves behind.
  await listening().close();
  server = undefined;
  await worker.evaluate(() => chrome.storage.session.remove("voices"));

  const page = await extension.openPopup();
  const reply = await request(page, "fetchVoices");
  // The control: the fetch did bring voices in, so a fallback had candidates.
  expect(reply).toEqual({ ok: true, value: expect.any(Number) });
  expect((reply as { value: number }).value).toBeGreaterThan(0);

  const after = await settings();
  expect(after.selection).toEqual(PICKED);
  expect(after.voicesByLanguage).toEqual(before.voicesByLanguage);
  expect(after.perProvider.custom).toEqual(before.perProvider.custom);

  await page.getByRole("link", { name: "Preferences" }).click();
  await expect(pickerTrigger(page)).toHaveText(/^beta/);
  await expect(pickerTrigger(page)).toHaveText(/Voice list unavailable/);
  await expect(pickerTrigger(page)).not.toHaveText(/No voices yet/);
  await page.close();
});

test("the provider coming back shows the kept voice in Preferences", async () => {
  server = await startFakeSpeechServer(port);

  const page = await extension.openPopup();
  await request(page, "fetchVoices");
  expect((await settings()).selection).toEqual(PICKED);

  await page.getByRole("link", { name: "Preferences" }).click();
  // The outage step already shows the voice by id, so recovery is the full description coming back and the warning going away.
  await expect(pickerTrigger(page)).toHaveText(/^beta/);
  await expect(pickerTrigger(page)).toHaveText(/OpenAI-compatible/);
  await expect(pickerTrigger(page)).not.toHaveText(/Voice list unavailable/);
  await page.close();
});

test("no popup console errors across the flow", () => {
  expect(extension.consoleErrors).toEqual([]);
});
