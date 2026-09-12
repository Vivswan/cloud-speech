import { DEV_WEB_PORT, SITE_LOCALES } from "@cloud-speech/constants";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { serveRenderedScreenshots } from "./src/lib/dev-screenshots.ts";
import { siteBase, siteOrigin } from "./src/lib/pages-tier.ts";

export default defineConfig({
  site: siteOrigin,
  base: siteBase,
  outDir: "dist",
  // The default HTML compression eats the space between text and an adjacent inline link ("the<a>source code</a>").
  compressHTML: false,
  // <route>/index.html: the extension links to the trailing-slash URLs (setup/<provider>/, pricing/).
  build: {
    format: "directory",
  },
  // English stays unprefixed: the extension and crawlers already link there. No `fallback`: it would silently
  // mask a missing translation, which generate-sitemap.mjs catches on the PR build instead.
  i18n: {
    defaultLocale: SITE_LOCALES[0].code,
    locales: SITE_LOCALES.map((locale) => locale.code),
    routing: {
      prefixDefaultLocale: false,
    },
  },
  // Published URLs from before the guides moved to top-level routes. Astro prefixes the source routes
  // with `base` but not the destinations.
  redirects: {
    "/setup/custom/local/": `${siteBase}setup/local/`,
    "/setup/custom/hosted/": `${siteBase}setup/custom/`,
  },
  server: {
    // The extension's dev builds link to this exact origin; keep it stable.
    port: DEV_WEB_PORT,
  },
  vite: {
    plugins: [tailwindcss(), serveRenderedScreenshots(siteBase)],
    server: {
      // The extension's links assume DEV_WEB_PORT, so fail instead of drifting to the next port. Astro's
      // top-level `server` schema strips unknown keys, so strictPort lives here.
      strictPort: true,
    },
  },
});
