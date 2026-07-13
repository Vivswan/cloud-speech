import { DEV_WEB_PORT, SITE_BASE, SITE_ORIGIN } from "@cloud-speech/constants";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  // Served from SITE_ORIGIN + SITE_BASE (see packages/constants — the single
  // source for site identity, shared with the extension).
  site: SITE_ORIGIN,
  base: SITE_BASE,
  outDir: "dist",
  // Keep authored whitespace: the default HTML compression eats the space
  // between text and an adjacent inline link ("the<a>source code</a>").
  compressHTML: false,
  // Each page builds to <route>/index.html, matching the URLs the extension
  // links to (setup/<provider>/, pricing/, troubleshooting/, privacy/).
  build: {
    format: "directory",
  },
  // The setup/custom/ subpages shipped briefly before the guides moved to
  // top-level routes; keep their URLs working. Astro prefixes the source
  // routes with `base` but not the destinations, so spell base out there.
  redirects: {
    "/setup/custom/local/": `${SITE_BASE}setup/local/`,
    "/setup/custom/hosted/": `${SITE_BASE}setup/custom/`,
  },
  server: {
    // The extension's dev builds link to this exact origin — keep it stable.
    port: DEV_WEB_PORT,
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      // Fail fast instead of drifting to the next port — the extension's
      // links assume DEV_WEB_PORT. (Astro's own top-level `server` schema
      // strips unknown keys, so strictPort has to live here.)
      strictPort: true,
    },
  },
});
