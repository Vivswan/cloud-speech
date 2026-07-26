import { DEV_WEB_PORT, SITE_BASE, SITE_ORIGIN } from "@cloud-speech/constants";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// GitHub Pages deploys (the managed pages.yml) export PAGES_ORIGIN and
// PAGES_BASE_PATH so one config serves both the production root and the
// /staging/ preview of main HEAD; every other build falls back to the
// constants (see packages/constants, the single source for site identity,
// shared with the extension).
const site = process.env.PAGES_ORIGIN ?? SITE_ORIGIN;
const base = process.env.PAGES_BASE_PATH ?? SITE_BASE;

export default defineConfig({
  site,
  base,
  outDir: "dist",
  // Keep authored whitespace: the default HTML compression eats the space
  // between text and an adjacent inline link ("the<a>source code</a>").
  compressHTML: false,
  // Each page builds to <route>/index.html, matching the URLs the extension
  // links to (setup/<provider>/, pricing/, troubleshooting/, privacy/).
  build: {
    format: "directory",
  },
  // English stays at the unprefixed URLs (the ones the extension links to and
  // crawlers already know); hi/zh-cn/zh-tw live in mirrored page trees under
  // src/pages/<locale>/. No `fallback`: every localized page is authored, and
  // a fallback would silently mask a missing translation.
  i18n: {
    defaultLocale: "en",
    locales: ["en", "hi", "zh-cn", "zh-tw"],
    routing: {
      prefixDefaultLocale: false,
    },
  },
  // The setup/custom/ subpages shipped briefly before the guides moved to
  // top-level routes; keep their URLs working. Astro prefixes the source
  // routes with `base` but not the destinations, so spell base out there.
  redirects: {
    "/setup/custom/local/": `${base}setup/local/`,
    "/setup/custom/hosted/": `${base}setup/custom/`,
  },
  server: {
    // The extension's dev builds link to this exact origin; keep it stable.
    port: DEV_WEB_PORT,
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      // Fail fast instead of drifting to the next port: the extension's
      // links assume DEV_WEB_PORT. (Astro's own top-level `server` schema
      // strips unknown keys, so strictPort has to live here.)
      strictPort: true,
    },
  },
});
