import sitemap from "@astrojs/sitemap";
import { DEV_WEB_PORT, SITE_LOCALES } from "@cloud-speech/constants";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { serveRenderedScreenshots } from "./src/lib/dev-screenshots.ts";
import { isIndexableTier, siteBase, siteOrigin } from "./src/lib/pages-tier.ts";

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
  // mask a missing translation, which scripts/check-page-locales.mts catches on the PR build instead.
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
  // The noindexed tiers (Base.astro) ship no sitemap: it would only advertise URLs crawlers are told to
  // ignore. The integration groups a page's locale variants by path and emits their hreflang alternates;
  // x-default is added here because it emits none on its own.
  integrations: isIndexableTier
    ? [
        sitemap({
          i18n: {
            defaultLocale: SITE_LOCALES[0].code,
            locales: Object.fromEntries(
              SITE_LOCALES.map((locale) => [locale.code, locale.hreflang]),
            ),
          },
          serialize(item) {
            const english = item.links?.find((link) => link.lang === SITE_LOCALES[0].hreflang);
            if (english)
              item.links = [...(item.links ?? []), { lang: "x-default", url: english.url }];
            return item;
          },
        }),
      ]
    : [],
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
