import { expect, type Page, test } from "@playwright/test";
import type { RouteId } from "../src/lib/protocol";
import type { Settings } from "../src/lib/storage";
import { type FakeSpeechServer, startFakeSpeechServer } from "./fake-provider/server";
import { type ExtensionSession, launchExtension } from "./fixtures";

// One provider's voice fetch failing while another's succeeds. The selected
// voice belongs to the failing provider and nothing of that provider is
// cached, which is what every fetch after a browser restart faces: the
// session cache starts empty. The selection must wait for the provider to
// come back, not move to a voice the other provider offers.
//
// The fake server stands in for the failing provider (it is closed for the
// outage and reopened at the same port). OpenAI is the provider that keeps
// answering: its voice list is static and needs no network, so a key that
// was never validated is enough for the fetch. The steps share one browser
// profile and build on each other in order.

const KEY = "fake-key";
const MODEL = "tts-1";
const PICKED = { providerId: "custom", voiceId: "beta", model: MODEL };

test.describe.configure({ mode: "serial" });

/** The fake server while it listens; undefined during the outage. */
let server: FakeSpeechServer | undefined;
/** The port the server listened on, where the extension expects it back. */
let port: number;
let extension: ExtensionSession;

/** The listening server, so a step that needs it fails plainly when the
 *  outage step left it closed. */
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

/** The extension API as the browser-side callbacks below see it, only the
 *  parts they touch. */
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

async function background() {
  const [worker] = extension.context.serviceWorkers();
  return worker ?? (await extension.context.waitForEvent("serviceworker"));
}

async function settings(): Promise<Settings> {
  const worker = await background();
  const stored = await worker.evaluate(() => chrome.storage.sync.get("settings"));
  return stored.settings as Settings;
}

/** A background request sent from the popup's own context and awaited to its
 *  reply, the one barrier that says the handler has finished. */
function request(page: Page, id: RouteId<"background">): Promise<unknown> {
  return page.evaluate((id) => chrome.runtime.sendMessage({ to: "background", id }), id);
}

/** What the voice picker's trigger shows: the selected voice's name, or the
 *  placeholder when the selection names no cached voice. */
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
  // A second provider that answers: OpenAI's static list needs no network.
  const worker = await background();
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

  // With its provider out, the picker cannot describe the kept voice.
  await page.getByRole("link", { name: "Preferences" }).click();
  await expect(pickerTrigger(page)).toHaveText(/No voices yet/);
  await page.close();
});

test("the provider coming back shows the kept voice in Preferences", async () => {
  server = await startFakeSpeechServer(port);

  const page = await extension.openPopup();
  await request(page, "fetchVoices");
  expect((await settings()).selection).toEqual(PICKED);

  await page.getByRole("link", { name: "Preferences" }).click();
  await expect(page.getByRole("button", { name: /^beta/ })).toBeVisible();
  await page.close();
});

test("no popup console errors across the flow", () => {
  expect(extension.consoleErrors).toEqual([]);
});
