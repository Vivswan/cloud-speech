import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page, type Worker } from "@playwright/test";
import type { Playback } from "../src/lib/playback";

// Every e2e suite loads the BUILT extension (chrome-mv3) into a real Chromium
// with a fresh profile of its own and drives the popup as a page.
// Build first: `bun run build:chrome` (the root `test:e2e` script does).

const EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../.output/chrome-mv3");

export interface ExtensionSession {
  readonly context: BrowserContext;
  /** The profile this browser runs on; removed by close(). */
  readonly userDataDir: string;
  /** The host of the MV3 service worker's origin. */
  readonly extensionId: string;
  /** Console errors of every page opened through openPopup(), in order.
   *  Only those popup pages are observed; the background is not. */
  readonly consoleErrors: readonly string[];
  /** A new page at popup.html, its console errors captured. */
  openPopup(): Promise<Page>;
  /** Close the browser and remove the profile, the removal running whether
   *  or not the close succeeds. */
  close(): Promise<void>;
}

/** Launch the extension in a profile created under the OS tmp dir with the
 *  given name prefix. The profile is removed when the launch fails as well. */
export function launchExtension(
  profilePrefix: string,
  options: LaunchOptions = {},
): Promise<ExtensionSession> {
  return launchExtensionOn(mkdtempSync(join(tmpdir(), profilePrefix)), options);
}

export interface LaunchOptions {
  /** Extra Chromium switches for this launch. */
  readonly args?: readonly string[];
  /** Device pixels per CSS pixel; Playwright's default when absent. */
  readonly deviceScaleFactor?: number;
  /** The browser's UI language, which the popup follows through chrome.i18n;
   *  the host's language when absent. */
  readonly locale?: string;
}

/** Launch the extension on an existing profile, which the returned session
 *  owns from here: its close() removes the profile, and so does a failed
 *  launch. Suites that need a browser restart on the same profile relaunch
 *  through this instead of a fresh profile. */
export async function launchExtensionOn(
  userDataDir: string,
  options: LaunchOptions = {},
): Promise<ExtensionSession> {
  let context: BrowserContext | undefined;
  const close = async () => {
    try {
      await context?.close();
    } finally {
      rmSync(userDataDir, { recursive: true, force: true });
    }
  };

  try {
    const launched = await chromium.launchPersistentContext(userDataDir, {
      channel: "chromium",
      // Extensions require the NEW headless mode (Playwright's chromium channel).
      headless: true,
      deviceScaleFactor: options.deviceScaleFactor,
      locale: options.locale,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        ...(options.args ?? []),
      ],
    });
    context = launched;

    const worker = await serviceWorkerOf(launched);
    const extensionId = new URL(worker.url()).host;
    const consoleErrors: string[] = [];

    return {
      context: launched,
      userDataDir,
      extensionId,
      consoleErrors,
      async openPopup() {
        const page = await launched.newPage();
        page.on("console", (message) => {
          if (message.type() === "error") consoleErrors.push(message.text());
        });
        await page.goto(`chrome-extension://${extensionId}/popup.html`);
        return page;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

/** The extension's MV3 service worker, waited for when it has not started yet. */
async function serviceWorkerOf(context: BrowserContext): Promise<Worker> {
  const [worker] = context.serviceWorkers();
  return worker ?? (await context.waitForEvent("serviceworker"));
}

/** The session's background: the service worker that owns the extension's
 *  state, where a suite reads storage as the background wrote it. */
export function background(extension: ExtensionSession): Promise<Worker> {
  return serviceWorkerOf(extension.context);
}

/** The extension API as the callback below sees it inside the worker, only
 *  the part it touches. */
declare const chrome: {
  storage: { session: { get(key: string): Promise<Record<string, unknown>> } };
};

/** The playback document (storage.session), as the background last wrote it;
 *  idle until it has written one. */
export async function readPlayback(extension: ExtensionSession): Promise<Playback> {
  const worker = await background(extension);
  const stored = await worker.evaluate(() => chrome.storage.session.get("playback"));
  return (stored.playback as Playback | undefined) ?? { status: "idle", epoch: 0, rate: 1 };
}
