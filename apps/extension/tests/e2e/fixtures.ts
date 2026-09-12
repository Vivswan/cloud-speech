import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BrowserContext, chromium, type Page, type Worker } from "@playwright/test";
import type { Playback } from "../../src/lib/playback";

// Suites load the BUILT extension (chrome-mv3): run `bun run build:chrome` first (the root `test:e2e` script does).

const EXTENSION_PATH = resolve(dirname(fileURLToPath(import.meta.url)), "../../.output/chrome-mv3");

export interface ExtensionSession {
  readonly context: BrowserContext;
  /** The profile this browser runs on; removed by close(). */
  readonly userDataDir: string;
  readonly extensionId: string;
  /** Only pages opened through openPopup() are observed; the background is not. */
  readonly consoleErrors: readonly string[];
  openPopup(): Promise<Page>;
  /** Removes the profile whether or not the browser close succeeds. */
  close(): Promise<void>;
}

export function launchExtension(
  profilePrefix: string,
  options: LaunchOptions = {},
): Promise<ExtensionSession> {
  return launchExtensionOn(mkdtempSync(join(tmpdir(), profilePrefix)), options);
}

export interface LaunchOptions {
  readonly args?: readonly string[];
  readonly deviceScaleFactor?: number;
  /** The browser's UI language, which the popup follows through chrome.i18n. */
  readonly locale?: string;
}

/** The returned session owns the profile from here: its close() removes it, and so does a failed launch.
 *  Suites that need a browser restart on the same profile relaunch through this instead of a fresh profile. */
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

async function serviceWorkerOf(context: BrowserContext): Promise<Worker> {
  const [worker] = context.serviceWorkers();
  return worker ?? (await context.waitForEvent("serviceworker"));
}

export function background(extension: ExtensionSession): Promise<Worker> {
  return serviceWorkerOf(extension.context);
}

declare const chrome: {
  storage: { session: { get(key: string): Promise<Record<string, unknown>> } };
};

export async function readPlayback(extension: ExtensionSession): Promise<Playback> {
  const worker = await background(extension);
  const stored = await worker.evaluate(() => chrome.storage.session.get("playback"));
  return (stored.playback as Playback | undefined) ?? { status: "idle", epoch: 0, rate: 1 };
}
