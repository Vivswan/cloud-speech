import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { DEV_SITE_URL, EXTENSION_NAME, SHORTCUTS, SITE_URL } from "@cloud-speech/constants";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "wxt";
import rootPackage from "../../package.json" with { type: "json" };
import { facePackageFile, facePath, TYPEFACES } from "./src/lib/fonts";

/**
 * One build per browser.
 *   chrome   one zip, published unchanged to two Chrome Web Store listings (update-release.yml): the
 *            "Cloud Speech" listing, the original Polly listing renamed in place, and the Azure-era
 *            listing, kept updated so its installs get the settings handoff. A build learns which
 *            listing it runs in from its extension ID at runtime (LEGACY_IDS in @cloud-speech/constants).
 *   firefox  MV3 event page for addons.mozilla.org; no offscreen API there, so audio plays in the
 *            background page (src/lib/audio-host.ts).
 */

// Permanent AMO add-on ID. Must never change once the first version is uploaded (it also unlocks
// storage.sync on Firefox).
const GECKO_ID = "cloud-speech@vivswan.github.io";

// Dev-only: pins the unpacked extension ID on every machine (without it the ID hashes the install path
// and changes when the repo moves). The PUBLIC key only, and never in store builds: each listing keeps
// its store-assigned ID.
const DEV_MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2DLuXMg/ZJn4tCwezoNO7DC+IRRxva1k6MQl1Z/V13cjFJ4sl7SEk7xQExfu/pcsm/J9ru0z5I3T7/vT0eGKDhH44Jrm9hgPNvPhm0KVS0m/uPPL9WkZu41TPNO4AMsBsfKoDlKw2jUinJyFHE4dXFKVvGc7x4HLYKBqswDHn5y5CucGsvXsh3jlHxNPYZWYdIxB7WtXGfHol0TdfObFn7xAn7hw0RVoTJO/+pHKadFm5Z4kmm8+Hm0Hw/Tc4U/B3lL8TmHMO3x99oypZqFqYVZVULXXrFS0bGHH7HhNaeo8V3lcEBgfIEGf27xVUAss7ZynqZVAa5l9OwkrxPLHZQIDAQAB";
const DEV_EXTENSION_ID = "kklpbekjdehodekehpchfeggmlgadekp"; // derived from the key above

// Only for the dev-tooling gates below (chromium profile, start URLs), which run before WXT resolves its
// config; the zip templates use WXT's own {{browser}}.
const argvBrowser = (() => {
  for (let i = 0; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === "-b" || arg === "--browser") return process.argv[i + 1] ?? "chrome";
    if (arg?.startsWith("--browser=")) return arg.slice("--browser=".length);
  }
  return "chrome";
})();
const isFirefoxCli = argvBrowser === "firefox";

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
    excludeSources: ["apps/extension/.output/**", "apps/web/dist/**", "sources/**", "**/*.zip"],
  },
  hooks: {
    // WXT stats the sources-zip listing against process.cwd(), not sourcesRoot
    // (core/utils/log/printFileList.ts), warning once per file otherwise. `wxt zip` exits right after,
    // so nothing else sees the changed cwd.
    "zip:sources:start": (wxt) => process.chdir(wxt.config.zip.sourcesRoot),
    // The popup and the content-script toast load the typefaces by path at runtime (src/lib/fonts.ts),
    // so they bypass Vite's hashed assets. The license rides along at the package root so every store
    // zip carries its terms (scripts/verify-zips.mjs checks it against the root file).
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
    // A persistent profile, so credentials, the loaded extension, and page logins survive dev-server
    // restarts; web-ext needs the directory to EXIST and be absolute, hence the mkdirSync. Firefox dev
    // (`dev:firefox`) uses web-ext's own temporary profile.
    chromiumProfile: (() => {
      const profile = resolve(__dirname, ".wxt/chrome-data");

      // Only the CHROME dev server (`wxt` with no subcommand) may reclaim the profile: every wxt
      // command, and vitest through WxtVitest, evaluates this file, and reclaiming from those would
      // kill a dev browser running alongside.
      const subcommands = ["build", "zip", "prepare", "clean", "submit", "init"];
      const isWxtCli = process.argv[1]?.split("/").pop()?.startsWith("wxt") ?? false;
      const isDevServe = isWxtCli && !process.argv.some((arg) => subcommands.includes(arg));
      if (!isDevServe || isFirefoxCli) return profile;

      mkdirSync(profile, { recursive: true });

      // A Chrome from a PREVIOUS dev session still holding this profile makes any new launch delegate
      // to it and exit within ~1s ("browser opens then instantly closes"), so the leftover instance is
      // closed first.
      try {
        // execFile, no shell: the profile path must reach pkill as ONE argument, never re-parsed by a
        // shell.
        execFileSync("pkill", ["-f", `user-data-dir=${profile}`], { stdio: "ignore" });
      } catch {
        // pkill exits non-zero when nothing matched; that's the normal case.
      }

      // Chrome flushes its Preferences on shutdown, which would overwrite the cleanup below and race
      // the new launch for the profile, so wait until the reclaimed instance has EXITED. Bounded, so an
      // unkillable process cannot hang the launch.
      let reclaimed = false;
      for (let attempt = 0; attempt < 30; attempt++) {
        try {
          execFileSync("pgrep", ["-f", `user-data-dir=${profile}`], { stdio: "ignore" });
          execFileSync("sleep", ["0.1"]);
        } catch {
          reclaimed = true;
          break;
        }
      }
      if (!reclaimed) {
        console.warn("A Chrome instance still holds the dev profile; the launch may fail.");
      }

      // chrome://extensions Developer mode is a MAC-protected TRACKED pref in current Chrome ("Secure
      // Preferences"), so a copy in the plain Preferences file registers as tampering and RESETS the
      // toggle on every launch. Toggle it once by hand; keepProfileChanges persists it.
      try {
        const prefsFile = resolve(profile, "Default/Preferences");
        if (existsSync(prefsFile)) {
          const prefs = JSON.parse(readFileSync(prefsFile, "utf8"));
          if (prefs.extensions?.ui && "developer_mode" in prefs.extensions.ui) {
            delete prefs.extensions.ui.developer_mode;
            writeFileSync(prefsFile, JSON.stringify(prefs));
          }
        }
      } catch (error) {
        console.warn("Could not clean the dev profile's Preferences:", error);
      }

      return profile;
    })(),
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
      // scripts/verify-zips.mjs asserts the zipped manifests carry this name.
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
