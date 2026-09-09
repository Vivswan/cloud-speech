import { expect, test } from "@playwright/test";
import { MONO, SANS } from "../../src/lib/fonts";
import { background, type ExtensionSession, launchExtension } from "./fixtures";
import { readToastFonts, TOAST_ERROR, TOAST_FONT } from "./font-probe";

/** The extension API as the background sees it, only the part the toast
 *  scene touches. */
declare const chrome: {
  tabs: {
    query(query: { url: string }): Promise<{ id: number }[]>;
    sendMessage(tabId: number, message: unknown): Promise<unknown>;
  };
};

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

test("popup text renders in the bundled typefaces on any OS", async () => {
  const page = await extension.openPopup();
  // Preferences shows both families: body text and the shortcut <kbd> chips.
  await page.getByRole("link", { name: "Preferences" }).click();
  await expect(page.locator("kbd").first()).toBeVisible();

  const fonts = await page.evaluate(
    async ([sans, mono]) => {
      // Every bundled weight must load, not only the ones this view's text
      // happens to use; a missing or misnamed file leaves its face in error.
      const faces = [...document.fonts];
      await Promise.all(faces.map((face) => face.load().catch(() => undefined)));
      // A face that failed to load leaves the text in the fallback family, so
      // the probe must measure differently from that fallback.
      const width = (family: string) => {
        const probe = document.createElement("span");
        probe.textContent = "Cloud Speech reads the selection aloud";
        probe.style.font = `400 16px ${family}`;
        document.body.append(probe);
        const measured = probe.getBoundingClientRect().width;
        probe.remove();
        return measured;
      };
      const kbd = document.querySelector("kbd");
      // The sidebar's product name is the one font-bold (700) text.
      const title = document.querySelector("img[alt=''] + div > div");
      return {
        body: getComputedStyle(document.body).fontFamily,
        kbd: kbd ? getComputedStyle(kbd).fontFamily : null,
        titleWeight: title ? getComputedStyle(title).fontWeight : null,
        faces: faces
          .map((face) => `${face.family.replace(/"/g, "")} ${face.weight} ${face.status}`)
          .sort(),
        sansDistinctFromFallback: width(`"${sans}"`) !== width("system-ui"),
        monoDistinctFromFallback: width(`"${mono}"`) !== width("ui-monospace"),
      };
    },
    [SANS.family, MONO.family],
  );
  expect(fonts.body).toMatch(new RegExp(`^"?${SANS.family}"?, system-ui`));
  expect(fonts.kbd).toMatch(new RegExp(`^"?${MONO.family}"?, ui-monospace`));
  expect(fonts.titleWeight).toBe("700");
  expect(fonts.faces).toEqual(
    [SANS, MONO]
      .flatMap((typeface) => typeface.weights.map((w) => `${typeface.family} ${w} loaded`))
      .sort(),
  );
  expect(fonts.sansDistinctFromFallback).toBe(true);
  expect(fonts.monoDistinctFromFallback).toBe(true);

  await page.close();
});

test("an error toast on a web page renders in the bundled sans", async () => {
  const page = await extension.context.newPage();
  await page.route("http://toast.test/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<!doctype html><p>A web page.</p>" }),
  );
  await page.goto("http://toast.test/");
  const worker = await background(extension);
  // Pushed the way the background does on a failed read (lib/errors.ts).
  const reply = await worker.evaluate(async (payload) => {
    const [tab] = await chrome.tabs.query({ url: "http://toast.test/*" });
    if (!tab) throw new Error("the page tab is gone");
    return chrome.tabs.sendMessage(tab.id, { to: "content", id: "setError", payload });
  }, TOAST_ERROR);
  expect(reply).toEqual({ ok: true });

  const fonts = await page.evaluate(readToastFonts, TOAST_FONT);
  expect(fonts.family).toMatch(new RegExp(`^"?${TOAST_FONT}"?, system-ui`));
  expect([...fonts.faces].sort()).toEqual([`${TOAST_FONT} 400 loaded`, `${TOAST_FONT} 600 loaded`]);

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
