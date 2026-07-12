import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

export default defineConfig({
  // Served from https://vivswan.github.io/cloud-speech-for-chrome/
  site: "https://vivswan.github.io",
  base: "/cloud-speech-for-chrome/",
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
    "/setup/custom/local/": "/cloud-speech-for-chrome/setup/local/",
    "/setup/custom/hosted/": "/cloud-speech-for-chrome/setup/custom/",
  },
  server: {
    // The extension's dev builds link to this exact origin — keep it stable.
    port: 5173,
  },
  vite: {
    plugins: [tailwindcss()],
    server: {
      // Fail fast instead of drifting to 5174 — the extension's links assume
      // 5173. (Astro's own top-level `server` schema strips unknown keys, so
      // strictPort has to live here.)
      strictPort: true,
    },
  },
});
