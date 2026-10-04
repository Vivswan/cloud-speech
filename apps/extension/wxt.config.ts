import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DEV_SITE_URL, EXTENSION_NAME, SHORTCUTS, SITE_URL } from "@cloud-speech/constants";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Wxt } from "wxt";
import rootPackage from "../../package.json" with { type: "json" };
import { reclaimChromeProfile } from "./dev-profile";
import { facePackageFile, facePath, TYPEFACES } from "./src/lib/fonts";

/**
 * One build per browser.
 *   chrome   one zip for the Chrome Web Store "Cloud Speech" listing (update-release.yml), the
 *            original Polly listing renamed in place (CHROME_LISTING_ID in @cloud-speech/constants).
 *   firefox  MV3 event page for addons.mozilla.org; no offscreen API there, so audio plays in the
 *            background page (src/lib/audio-host.ts).
 */

// Permanent AMO add-on ID. Must never change once the first version is uploaded (it also unlocks
// storage.sync on Firefox).
const GECKO_ID = "cloud-speech@vivswan";

// Dev-only: pins the unpacked extension ID on every machine (without it the ID hashes the install path
// and changes when the repo moves). The PUBLIC key only, and never in store builds: each listing keeps
// its store-assigned ID.
const DEV_MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2DLuXMg/ZJn4tCwezoNO7DC+IRRxva1k6MQl1Z/V13cjFJ4sl7SEk7xQExfu/pcsm/J9ru0z5I3T7/vT0eGKDhH44Jrm9hgPNvPhm0KVS0m/uPPL9WkZu41TPNO4AMsBsfKoDlKw2jUinJyFHE4dXFKVvGc7x4HLYKBqswDHn5y5CucGsvXsh3jlHxNPYZWYdIxB7WtXGfHol0TdfObFn7xAn7hw0RVoTJO/+pHKadFm5Z4kmm8+Hm0Hw/Tc4U/B3lL8TmHMO3x99oypZqFqYVZVULXXrFS0bGHH7HhNaeo8V3lcEBgfIEGf27xVUAss7ZynqZVAa5l9OwkrxPLHZQIDAQAB";
const DEV_EXTENSION_ID = "kklpbekjdehodekehpchfeggmlgadekp"; // derived from the key above

// Only for the start URLs below, which WXT reads before it has resolved `-b`; the zip templates use
// WXT's own {{browser}}.
const argvBrowser = (() => {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "-b" || arg === "--browser") return process.argv[i + 1] ?? "chrome";
    if (arg?.startsWith("--browser=")) return arg.slice("--browser=".length);
  }
  return "chrome";
})();
const isFirefoxCli = argvBrowser === "firefox";

// The Chrome dev server's persistent profile, so credentials, the loaded extension, and page logins
// survive dev-server restarts. Firefox dev (`dev:firefox`) uses web-ext's own temporary profile.
const CHROMIUM_PROFILE = resolve(__dirname, ".wxt/chrome-data");
const prepareChromeProfile = async (wxt: Wxt): Promise<void> => {
  const chromium = !["firefox", "safari"].includes(wxt.config.browser);
  if (chromium && !wxt.config.webExt.config.disabled) {
    await reclaimChromeProfile(CHROMIUM_PROFILE, wxt.logger);
  }
};

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/i18n/module", "@wxt-dev/auto-icons"],
  zip: {
    artifactTemplate: "cloud-speech-{{version}}-{{browser}}.zip",
    // AMO reviewers rebuild from source; the monorepo root ships so `bun run --cwd apps/extension
    // build:firefox` works from the sources zip.
    sourcesTemplate: "cloud-speech-{{version}}-{{browser}}-sources.zip",
    sourcesRoot: resolve(__dirname, "../.."),
    // The default glob skips dotfiles; the README sends AMO reviewers to .bun-version for the bun
    // version to install, so the zip must carry it.
    includeSources: ["**/*", ".bun-version"],
    excludeSources: ["apps/extension/.output/**", "apps/web/dist/**", "**/*.zip"],
  },
  hooks: {
    // WXT stats the sources-zip listing against process.cwd(), not sourcesRoot
    // (core/utils/log/printFileList.ts), warning once per file otherwise. `wxt zip` exits right after,
    // so nothing else sees the changed cwd.
    "zip:sources:start": (wxt) => process.chdir(wxt.config.zip.sourcesRoot),
    // Every browser launch goes through the resolved config's runner, and a reload resolves a new
    // runner, so wrapping it here covers the first launch and the `o` + enter reopen, which WXT does
    // without a hook of its own. Ordinary source reloads resolve a runner too but never open it.
    "config:resolved": (wxt) => {
      const runner = wxt.config.runner;
      const open = runner.openBrowser.bind(runner);
      runner.openBrowser = async () => {
        await prepareChromeProfile(wxt);
        await open();
      };
    },
    // The popup and the content-script toast load the typefaces by path at runtime (src/lib/fonts.ts),
    // so they bypass Vite's hashed assets. The license rides along at the package root so every store
    // zip carries its terms (scripts/verify-zips.mts checks it against the root file).
    "build:publicAssets": (_wxt, files) => {
      files.push({
        absoluteSrc: resolve(__dirname, "../../LICENSE.md"),
        relativeDest: "LICENSE.md",
      });
      const require = createRequire(import.meta.url);
      for (const typeface of TYPEFACES) {
        for (const weight of typeface.weights) {
          const file = facePackageFile(typeface, weight);
          let absoluteSrc: string;
          try {
            absoluteSrc = require.resolve(file);
          } catch {
            // A build without its fonts must not ship (the popup would fall back to system fonts), and
            // Node's bare "Cannot find module" does not say that the fix is an install.
            throw new Error(
              `Font file ${file} is not installed; run \`bun install\` (the extension bundles its typeface from @fontsource packages).`,
            );
          }
          files.push({ absoluteSrc, relativeDest: facePath(typeface, weight) });
        }
      }
    },
    // ...and let `browser.runtime.getURL` accept those paths.
    "prepare:publicPaths": (_wxt, paths) => {
      // The `${string}` is TypeScript's, spliced into .wxt/types/paths.d.ts.
      // biome-ignore lint/suspicious/noTemplateCurlyInString: type syntax, not a template
      paths.push({ type: "templateLiteral", path: "fonts/${string}.woff2" });
    },
  },
  autoIcons: {
    baseIconPath: "assets/icon.svg",
    // Dev builds keep the full-color icon (default grayscales them).
    developmentIndicator: false,
  },
  webExt: {
    chromiumProfile: CHROMIUM_PROFILE,
    keepProfileChanges: true,
    // The popup URL uses DEV_EXTENSION_ID, identical on every machine and install path because
    // DEV_MANIFEST_KEY pins it; Firefox assigns its own internal UUID, so no popup tab there.
    startUrls: [
      DEV_SITE_URL,
      ...(isFirefoxCli ? [] : [`chrome-extension://${DEV_EXTENSION_ID}/popup.html`]),
    ],
  },
  vite: () => ({
    plugins: [
      react({
        babel: {
          plugins: ["babel-plugin-react-compiler"],
        },
      }),
      tailwindcss(),
    ],
    build: {
      // Extension files load from disk, so code-splitting buys nothing and Vite's network-oriented
      // 500 kB warning is noise. Kept just above the current ~4.6 MB (the Polly SDK and the wink-nlp
      // English model) so meaningful growth still warns.
      chunkSizeWarningLimit: 5120,
    },
  }),
  manifest: ({ browser, command }) => {
    const firefox = browser === "firefox";

    return {
      // scripts/verify-zips.mts asserts the zipped manifests carry this name.
      name: EXTENSION_NAME,
      // Never valid on Firefox, never in store builds (see DEV_MANIFEST_KEY).
      ...(command === "serve" && !firefox ? { key: DEV_MANIFEST_KEY } : {}),
      // release-please bumps the ROOT package.json; the store version must track it (a stale workspace
      // version would be rejected by the store).
      version: rootPackage.version,
      ...(firefox
        ? {
            browser_specific_settings: {
              // strict_min_version 140 = the first desktop Firefox that reads the
              // data_collection_permissions key below (the linter warns when a floor predates a key).
              gecko: {
                id: GECKO_ID,
                strict_min_version: "140.0",
                // Firefox's built-in consent prompt, mandatory for new AMO submissions since Nov 2025.
                // Nothing is ever sent to us: the categories are what the extension transmits DIRECTLY
                // to the TTS provider the USER configured (see the website privacy policy), the selected
                // text (websiteContent) and the user's own API credentials (authenticationInfo).
                data_collection_permissions: {
                  required: ["websiteContent", "authenticationInfo"],
                },
              },
              // 142 is the first Firefox for Android that reads data_collection_permissions (same linter
              // rule as above). The context menu and commands APIs are absent there; the background
              // feature-detects them (src/lib/platform.ts) and the popup is the entry point.
              gecko_android: {
                strict_min_version: "142.0",
              },
            },
          }
        : {
            // runtime.getContexts + offscreen APIs used by Chrome playback.
            minimum_chrome_version: "116",
          }),
      description: "__MSG_extDescription__",
      default_locale: "en",
      homepage_url: SITE_URL,
      permissions: [
        "contextMenus",
        "downloads",
        "storage",
        "scripting",
        // No offscreen API on Firefox; audio plays in the background event page (src/lib/audio-host.ts).
        ...(firefox ? [] : ["offscreen"]),
      ],
      host_permissions: ["<all_urls>"],
      // The content-script toast loads the bundled typeface from the page.
      web_accessible_resources: [{ resources: ["fonts/*.woff2"], matches: ["<all_urls>"] }],
      // The website and README render the same SHORTCUTS; the descriptions reuse the popup's shortcut
      // labels so chrome://extensions/shortcuts is localized and worded like the UI.
      commands: {
        readAloudShortcut: {
          suggested_key: { ...SHORTCUTS.readAloud },
          description: "__MSG_settings_shortcut_read__",
        },
        downloadShortcut: {
          suggested_key: { ...SHORTCUTS.download },
          description: "__MSG_settings_shortcut_download__",
        },
      },
    };
  },
});
