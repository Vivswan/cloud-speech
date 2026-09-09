import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { By, until, type WebElement } from "selenium-webdriver";
import { Driver, Options, ServiceBuilder } from "selenium-webdriver/firefox.js";

// The Firefox suites load the BUILT extension (firefox-mv3) as a temporary
// add-on into a stock Firefox through geckodriver, and drive the popup as a
// tab. Playwright's Firefox is a patched build that cannot load extensions,
// so this harness is Selenium. Build first: `bun run build:firefox` (the root
// `test:e2e:firefox` script does). Firefox itself comes from the machine
// (geckodriver finds the default install on macOS and `firefox` on PATH).

export const EXTENSION_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../.output/firefox-mv3",
);

// Firefox hands a temporary add-on a random internal UUID unless this pref
// pins one per add-on ID, and the popup URL needs it before the install.
const EXTENSION_UUID = "2f1e6c1a-4d0e-4c5b-9b7a-1d2e3f4a5b6c";

function geckoId(): string {
  const manifest = JSON.parse(readFileSync(resolve(EXTENSION_PATH, "manifest.json"), "utf8"));
  return manifest.browser_specific_settings.gecko.id;
}

export interface FirefoxPopup {
  /** Run `script` (a function body or arrow function source) in the popup
   *  page; a returned promise is awaited. Marionette runs it in a fresh
   *  sandbox per call whose `window` is the real page global, so state meant
   *  to outlive the call goes on `window`, never on the sandbox's globalThis. */
  evaluate<T>(script: string | ((...args: never[]) => unknown), ...args: unknown[]): Promise<T>;
  /** The first element matching the XPath, waited for. */
  find(xpath: string, timeout?: number): Promise<WebElement>;
  /** The provider's Settings row, expanded. */
  providerRow(providerId: string, title: string): Promise<WebElement>;
  /** The input the given label points at, inside `scope`. */
  labelled(scope: WebElement, label: string): Promise<WebElement>;
  /** Text content of the whole page, for "is this shown" checks. */
  text(): Promise<string>;
  /** Close this tab, whichever tab is current; the browser stays up on its
   *  blank base tab. */
  close(): Promise<void>;
}

export interface FirefoxPage {
  /** Run `script` in the page, as FirefoxPopup.evaluate does in the popup. */
  evaluate<T>(script: string | ((...args: never[]) => unknown), ...args: unknown[]): Promise<T>;
  /** Make this tab the driver's current one again after another tab was used. */
  focus(): Promise<void>;
  /** Close this tab, whichever tab is current; the browser stays up on its
   *  blank base tab. */
  close(): Promise<void>;
}

export interface FirefoxExtensionSession {
  readonly driver: Driver;
  /** A new tab at popup.html, its root view rendered, then switched to
   *  `view` when given. */
  openPopup(view?: "Preferences" | "Settings"): Promise<FirefoxPopup>;
  /** A new tab at an ordinary web page, its body present. */
  openPage(url: string): Promise<FirefoxPage>;
  /** Quit the browser; geckodriver removes the profile it created. */
  close(): Promise<void>;
}

/** Launch a headless Firefox with the extension installed. The profile is
 *  geckodriver's own temporary one, created for the session and removed with
 *  it. */
export async function launchFirefoxExtension(): Promise<FirefoxExtensionSession> {
  const options = new Options()
    .addArguments("-headless")
    .setPreference(
      "extensions.webextensions.uuids",
      JSON.stringify({ [geckoId()]: EXTENSION_UUID }),
    );
  // With no executable path, Selenium takes geckodriver from PATH or has
  // Selenium Manager download the release matching the installed Firefox.
  // Marionette refuses to navigate a tab to a moz-extension:// URL unless
  // geckodriver grants system access.
  const service = new ServiceBuilder().addArguments("--allow-system-access");
  const driver = Driver.createSession(options, service.build());
  const close = () => driver.quit();

  try {
    await driver.installAddon(EXTENSION_PATH, true);
    const baseHandle = await driver.getWindowHandle();
    const popupUrl = `moz-extension://${EXTENSION_UUID}/popup.html`;

    return {
      driver,
      async openPage(url) {
        await driver.switchTo().newWindow("tab");
        const handle = await driver.getWindowHandle();
        await driver.get(url);
        await driver.wait(until.elementLocated(By.css("body")), 10_000);
        return {
          evaluate: <T>(script: string | ((...args: never[]) => unknown), ...args: unknown[]) =>
            driver.executeScript(script, ...args) as Promise<T>,
          focus: () => driver.switchTo().window(handle),
          async close() {
            await driver.switchTo().window(handle);
            await driver.close();
            await driver.switchTo().window(baseHandle);
          },
        };
      },
      async openPopup(view) {
        await driver.switchTo().newWindow("tab");
        const handle = await driver.getWindowHandle();
        await driver.get(popupUrl);
        const find = (xpath: string, timeout = 10_000) =>
          driver.wait(until.elementLocated(By.xpath(xpath)), timeout);
        // The Sandbox view is the root route: its textarea says the app mounted.
        await find("//textarea");
        if (view) await (await find(`//a[normalize-space(.)="${view}"]`)).click();
        return {
          evaluate: <T>(script: string | ((...args: never[]) => unknown), ...args: unknown[]) =>
            driver.executeScript(script, ...args) as Promise<T>,
          find,
          async providerRow(providerId, title) {
            const row = await find(`//*[@data-testid="provider-${providerId}"]`);
            await (
              await row.findElement(By.xpath(`.//*[normalize-space(text())="${title}"]`))
            ).click();
            return row;
          },
          labelled: (scope, label) =>
            scope.findElement(
              By.xpath(`.//input[@id=//label[normalize-space(.)="${label}"]/@for]`),
            ),
          text: () => driver.findElement(By.css("body")).getText(),
          async close() {
            await driver.switchTo().window(handle);
            await driver.close();
            await driver.switchTo().window(baseHandle);
          },
        };
      },
      close,
    };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}
