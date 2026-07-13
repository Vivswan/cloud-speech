import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { DEV_SITE_URL, EXTENSION_NAME, SITE_URL } from "@cloud-speech/constants";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "wxt";
import rootPackage from "../../package.json" with { type: "json" };

/**
 * One build per browser:
 *  - chrome: a single zip, published unchanged to all three Chrome Web Store
 *    listing IDs — the unified "Cloud Speech" listing plus the two
 *    legacy fork listings, which receive the same artifact so their users
 *    keep getting updates. Storage is extension-ID-scoped, so legacy-settings
 *    migration stays correct per listing.
 *  - firefox: MV3 event-page build for addons.mozilla.org, named
 *    "Cloud Speech" (no offscreen API there; audio plays in the background
 *    page — see src/lib/audio-host.ts).
 */
export const HOMEPAGE_URL = SITE_URL;

// Permanent AMO add-on ID — must never change once the first version is
// uploaded (it also unlocks storage.sync on Firefox).
const GECKO_ID = "cloud-speech@vivswan.github.io";

// DEV-ONLY manifest key: pins the unpacked extension ID on every machine
// (without it the ID is a hash of the install PATH and changes when the repo
// moves). Only the PUBLIC key — there is nothing secret here, and it is NOT
// included in store builds (each listing keeps its own store-assigned ID).
const DEV_MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2DLuXMg/ZJn4tCwezoNO7DC+IRRxva1k6MQl1Z/V13cjFJ4sl7SEk7xQExfu/pcsm/J9ru0z5I3T7/vT0eGKDhH44Jrm9hgPNvPhm0KVS0m/uPPL9WkZu41TPNO4AMsBsfKoDlKw2jUinJyFHE4dXFKVvGc7x4HLYKBqswDHn5y5CucGsvXsh3jlHxNPYZWYdIxB7WtXGfHol0TdfObFn7xAn7hw0RVoTJO/+pHKadFm5Z4kmm8+Hm0Hw/Tc4U/B3lL8TmHMO3x99oypZqFqYVZVULXXrFS0bGHH7HhNaeo8V3lcEBgfIEGf27xVUAss7ZynqZVAa5l9OwkrxPLHZQIDAQAB";
const DEV_EXTENSION_ID = "kklpbekjdehodekehpchfeggmlgadekp"; // derived from the key above

// The zip templates use WXT's own {{browser}} substitution; this argv parse
// exists ONLY for the dev-tooling gates below (chromium profile, start URLs),
// which run before WXT resolves its config. Handles `-b x`, `--browser x`,
// and `--browser=x`.
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
    // AMO reviewers rebuild from source; ship the monorepo root so
    // `bun run --cwd apps/extension zip:firefox` works from the sources zip.
    sourcesTemplate: "cloud-speech-{{version}}-{{browser}}-sources.zip",
    sourcesRoot: resolve(__dirname, "../.."),
    excludeSources: ["apps/extension/.output/**", "apps/web/dist/**", "sources/**", "**/*.zip"],
  },
  autoIcons: {
    baseIconPath: "assets/icon.svg",
    // Dev builds keep the full-color icon (default grayscales them).
    grayscaleOnDevelopment: false,
  },
  webExt: {
    // Persistent dev-browser profile: credentials, the loaded extension, and
    // any page logins survive dev-server restarts. web-ext requires the
    // profile directory to EXIST and be absolute, hence the mkdirSync.
    // Firefox dev (`dev:firefox`) uses web-ext's own temporary profile.
    chromiumProfile: (() => {
      const profile = resolve(__dirname, ".wxt/chrome-data");

      // The setup below must run ONLY when starting the CHROME dev server
      // (`wxt` with no subcommand). This config file is evaluated by EVERY
      // wxt command — build/zip/prepare, firefox runs, and even vitest via
      // WxtVitest — and reclaiming the profile from those would kill a dev
      // browser that is happily running alongside. So require BOTH: the
      // entrypoint is the wxt CLI itself, and no subcommand was given.
      const subcommands = ["build", "zip", "prepare", "clean", "submit", "init"];
      const isWxtCli = process.argv[1]?.split("/").pop()?.startsWith("wxt") ?? false;
      const isDevServe = isWxtCli && !process.argv.some((arg) => subcommands.includes(arg));
      if (!isDevServe || isFirefoxCli) return profile;

      mkdirSync(profile, { recursive: true });

      // A Chrome instance from a PREVIOUS dev session still holding this
      // profile makes any new launch delegate to it and exit within ~1s
      // ("browser opens then instantly closes"). One dev session owns the
      // profile: reclaim it by closing the leftover instance.
      try {
        // execFile (no shell): the profile path must reach pkill as ONE
        // argument, never be re-parsed by a shell.
        execFileSync("pkill", ["-f", `user-data-dir=${profile}`], { stdio: "ignore" });
      } catch {
        // pkill exits non-zero when nothing matched — that's the normal case.
      }

      // Wait until the reclaimed instance has actually EXITED: Chrome flushes
      // its Preferences on shutdown, which would overwrite the cleanup below
      // and race the new launch for the profile. pgrep exits non-zero once
      // nothing matches; bounded so an unkillable process can't hang us.
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

      // chrome://extensions Developer mode is a MAC-protected TRACKED pref in
      // current Chrome ("Secure Preferences"): writing it into the plain
      // Preferences file registers as tampering and RESETS the toggle on
      // every launch. So never write it — toggle it once by hand and
      // keepProfileChanges persists it. Remove the plain-Preferences copy an
      // older version of this config left behind, or the reset keeps firing.
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
    // Tabs opened on dev launch: the local guide site + (Chrome only) the
    // extension popup. The popup URL uses DEV_EXTENSION_ID, which is pinned by
    // DEV_MANIFEST_KEY and therefore identical on every machine and install
    // path; Firefox assigns its own internal UUID, so no popup tab there.
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
  }),
  manifest: ({ browser, command }) => {
    const firefox = browser === "firefox";

    return {
      // The display name lives in @cloud-speech/constants (verify-zips
      // asserts the zipped manifests match it).
      name: EXTENSION_NAME,
      // Pin the dev ID (see DEV_MANIFEST_KEY). Never shipped in store builds,
      // and never valid on Firefox.
      ...(command === "serve" && !firefox ? { key: DEV_MANIFEST_KEY } : {}),
      // release-please bumps the ROOT package.json — the store version must
      // track it (a stale workspace version would be rejected by the store).
      version: rootPackage.version,
      ...(firefox
        ? {
            browser_specific_settings: {
              // Permanent AMO ID; also required for storage.sync on Firefox.
              // strict_min_version 115 = the storage.session floor (an ESR).
              gecko: { id: GECKO_ID, strict_min_version: "115.0" },
            },
          }
        : {
            // runtime.getContexts + offscreen APIs used by Chrome playback.
            minimum_chrome_version: "116",
          }),
      description: "__MSG_extDescription__",
      default_locale: "en",
      homepage_url: HOMEPAGE_URL,
      permissions: [
        "contextMenus",
        "downloads",
        "storage",
        "activeTab",
        "scripting",
        // Firefox has no offscreen API; audio plays in the background event
        // page instead (src/lib/audio-host.ts).
        ...(firefox ? [] : ["offscreen"]),
      ],
      host_permissions: ["<all_urls>"],
      commands: {
        readAloudShortcut: {
          suggested_key: { default: "Ctrl+Shift+S", mac: "Command+Shift+S" },
          description: "Read aloud the selected text",
        },
        downloadShortcut: {
          suggested_key: { default: "Ctrl+Shift+E", mac: "Command+Shift+E" },
          description: "Download the selected text as audio",
        },
      },
    };
  },
});
