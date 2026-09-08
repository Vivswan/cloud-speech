import { DEV_WEB_PORT, SITE_LOCALES } from "@cloud-speech/constants";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { siteBase, siteOrigin } from "./src/lib/pages-tier.ts";

// GitHub Pages deploys (the managed pages.yml) export PAGES_ORIGIN and
// PAGES_BASE_PATH so one config serves every tier of the versioned site
// (root, latest/, vX.Y.Z/); every other build falls back to the
// constants. src/lib/pages-tier.ts reads them, plus PAGES_TIER, once for
// this config, the layout, and the sitemap script.
export default defineConfig({
  site: siteOrigin,
  base: siteBase,
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
  // crawlers already know); the other locales live in mirrored page trees
  // under src/pages/<locale>/. The roster comes from the shared locale table
  // in @cloud-speech/constants. No `fallback`: every localized page is
  // authored, and a fallback would silently mask a missing translation.
  i18n: {
    defaultLocale: SITE_LOCALES[0].code,
    locales: SITE_LOCALES.map((locale) => locale.code),
    routing: {
      prefixDefaultLocale: false,
    },
  },
  // The setup/custom/ subpages shipped briefly before the guides moved to
  // top-level routes; keep their URLs working. Astro prefixes the source
  // routes with `base` but not the destinations, so spell base out there.
  redirects: {
    "/setup/custom/local/": `${siteBase}setup/local/`,
    "/setup/custom/hosted/": `${siteBase}setup/custom/`,
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
