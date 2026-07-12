import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "wxt";
import rootPackage from "../../package.json" with { type: "json" };

/**
 * One codebase → three Chrome Web Store listings, selected via `--mode`:
 *  - polly: updates the existing "Polly for Chrome" listing in place
 *  - azure: updates the existing "Azure Speech for Chrome" listing in place
 *  - cloud: the new unified "Cloud Speech for Chrome" listing
 *
 * Only the listing name differs per mode; the code and homepage are identical
 * (single GitHub repo: vivswan/cloud-speech-for-chrome). Storage is
 * extension-ID-scoped, so legacy-settings migration is automatically correct
 * per listing (each one only ever sees its own fork's data).
 */
export const HOMEPAGE_URL = "https://vivswan.github.io/cloud-speech-for-chrome";

const BRANDING = {
  polly: { name: "Polly for Chrome" },
  azure: { name: "Azure Speech for Chrome" },
  cloud: { name: "Cloud Speech for Chrome" },
} as const;

type BuildTarget = keyof typeof BRANDING;

// DEV-ONLY manifest key: pins the unpacked extension ID on every machine
// (without it the ID is a hash of the install PATH and changes when the repo
// moves). Only the PUBLIC key — there is nothing secret here, and it is NOT
// included in store builds (each listing keeps its own store-assigned ID).
const DEV_MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA2DLuXMg/ZJn4tCwezoNO7DC+IRRxva1k6MQl1Z/V13cjFJ4sl7SEk7xQExfu/pcsm/J9ru0z5I3T7/vT0eGKDhH44Jrm9hgPNvPhm0KVS0m/uPPL9WkZu41TPNO4AMsBsfKoDlKw2jUinJyFHE4dXFKVvGc7x4HLYKBqswDHn5y5CucGsvXsh3jlHxNPYZWYdIxB7WtXGfHol0TdfObFn7xAn7hw0RVoTJO/+pHKadFm5Z4kmm8+Hm0Hw/Tc4U/B3lL8TmHMO3x99oypZqFqYVZVULXXrFS0bGHH7HhNaeo8V3lcEBgfIEGf27xVUAss7ZynqZVAa5l9OwkrxPLHZQIDAQAB";
const DEV_EXTENSION_ID = "kklpbekjdehodekehpchfeggmlgadekp"; // derived from the key above

// WXT's zip artifactTemplate has no {{mode}} variable, so resolve the CLI
// --mode here to keep the three listings' zips from overwriting each other.
const argvMode = (() => {
  const i = process.argv.indexOf("--mode");
  return i !== -1 ? process.argv[i + 1] : undefined;
})();
const zipTarget: BuildTarget =
  argvMode && argvMode in BRANDING ? (argvMode as BuildTarget) : "cloud";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/i18n/module", "@wxt-dev/auto-icons"],
  zip: {
    artifactTemplate: `cloud-speech-for-chrome-{{version}}-${zipTarget}.zip`,
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
    chromiumProfile: (() => {
      const profile = resolve(__dirname, ".wxt/chrome-data");

      // The setup below must run ONLY when starting the dev server (`wxt` with
      // no subcommand). This config file is evaluated by EVERY wxt command —
      // build/zip/prepare — and reclaiming the profile from those would kill a
      // dev browser that is happily running alongside.
      const subcommands = ["build", "zip", "prepare", "clean", "submit", "init"];
      const isDevServe = !process.argv.some((arg) => subcommands.includes(arg));
      if (!isDevServe) return profile;

      mkdirSync(profile, { recursive: true });

      // A Chrome instance from a PREVIOUS dev session still holding this
      // profile makes any new launch delegate to it and exit within ~1s
      // ("browser opens then instantly closes"). One dev session owns the
      // profile: reclaim it by closing the leftover instance.
      try {
        execSync(`pkill -f "user-data-dir=${profile}"`, { stdio: "ignore" });
      } catch {
        // pkill exits non-zero when nothing matched — that's the normal case.
      }

      // Enable chrome://extensions Developer mode (service-worker inspection,
      // error badges, etc.) — merged into the profile's Preferences on every
      // dev launch, so it applies to existing profiles too. Safe: any Chrome
      // holding the profile was reclaimed just above.
      try {
        const prefsFile = resolve(profile, "Default/Preferences");
        mkdirSync(resolve(profile, "Default"), { recursive: true });
        const prefs = existsSync(prefsFile) ? JSON.parse(readFileSync(prefsFile, "utf8")) : {};
        prefs.extensions = prefs.extensions ?? {};
        prefs.extensions.ui = prefs.extensions.ui ?? {};
        prefs.extensions.ui.developer_mode = true;
        writeFileSync(prefsFile, JSON.stringify(prefs));
      } catch (error) {
        console.warn("Could not enable Developer mode in the dev profile:", error);
      }

      return profile;
    })(),
    keepProfileChanges: true,
    // Tabs opened on dev launch: the local guide site + the extension popup.
    // The popup URL uses DEV_EXTENSION_ID, which is pinned by DEV_MANIFEST_KEY
    // and therefore identical on every machine and install path.
    startUrls: [
      "http://localhost:5173/cloud-speech-for-chrome/",
      `chrome-extension://${DEV_EXTENSION_ID}/popup.html`,
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
  manifest: ({ mode, command }) => {
    const target: BuildTarget = mode in BRANDING ? (mode as BuildTarget) : "cloud";
    const branding = BRANDING[target];

    return {
      name: branding.name,
      // Pin the dev ID (see DEV_MANIFEST_KEY). Never shipped in store builds.
      ...(command === "serve" ? { key: DEV_MANIFEST_KEY } : {}),
      // release-please bumps the ROOT package.json — the store version must
      // track it (a stale workspace version would be rejected by the store).
      version: rootPackage.version,
      // runtime.getContexts + offscreen APIs used by playback.
      minimum_chrome_version: "116",
      description: "__MSG_extDescription__",
      default_locale: "en",
      homepage_url: HOMEPAGE_URL,
      permissions: ["contextMenus", "downloads", "storage", "activeTab", "scripting", "offscreen"],
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
