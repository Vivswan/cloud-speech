#!/usr/bin/env bun
// Generate dist/sitemap.xml from the actual page files: the page list and
// the site URL each live in exactly one place (src/pages/ and
// packages/constants), so the sitemap can never drift again.
// Runs after `astro build` (see the build script in package.json).
//
// Locale-aware: the mirrored trees under src/pages/{hi,zh-cn,zh-tw}/ are
// grouped with their English page, and every entry lists all of its language
// variants as xhtml:link alternates (plus x-default → English), matching the
// hreflang links Base.astro puts in each page's <head>.

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_BASE, SITE_ORIGIN } from "@cloud-speech/constants";
import { LOCALES } from "../src/i18n/locales.ts";

// Match astro.config.mjs: Pages deploys (the managed pages.yml) export
// PAGES_ORIGIN/PAGES_BASE_PATH per variable; other builds use the constants.
const siteUrl = `${process.env.PAGES_ORIGIN ?? SITE_ORIGIN}${process.env.PAGES_BASE_PATH ?? SITE_BASE}`;

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pagesDir = resolve(webRoot, "src/pages");
const outFile = resolve(webRoot, "dist/sitemap.xml");

// The /staging/ preview is noindexed (see Base.astro); a sitemap would only
// advertise URLs crawlers are told to ignore.
if (process.env.PAGES_STAGING) {
  console.log("sitemap.xml: skipped (staging build)");
  process.exit(0);
}

const routes = readdirSync(pagesDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".astro"))
  .map((entry) => relative(pagesDir, resolve(entry.parentPath, entry.name)))
  .filter((page) => page !== "404.astro")
  .map((page) => {
    const route = page.replace(/\.astro$/, "");
    return route === "index" ? "" : `${route.replace(/\/index$/, "")}/`;
  })
  .sort();

const localeOf = (route) =>
  LOCALES.find((l) => l.prefix && route.startsWith(l.prefix)) ?? LOCALES[0];

// locale-relative page path → Set of locale codes that have it.
const byPage = new Map();
for (const route of routes) {
  const locale = localeOf(route);
  const pagePath = locale.prefix ? route.slice(locale.prefix.length) : route;
  if (!byPage.has(pagePath)) byPage.set(pagePath, new Set());
  byPage.get(pagePath).add(locale.code);
}

// Route parity: Base.astro emits hreflang links to ALL four variants of every
// page, so a page missing from any locale tree would ship broken alternate
// links. Fail the build instead.
const incomplete = [...byPage.entries()]
  .filter(([, variants]) => variants.size !== LOCALES.length)
  .map(
    ([pagePath, variants]) =>
      `  ${pagePath || "(home)"}: missing ${LOCALES.filter((l) => !variants.has(l.code))
        .map((l) => l.code)
        .join(", ")}`,
  );
if (incomplete.length > 0) {
  console.error(
    `sitemap: ${incomplete.length} page(s) are not translated into every locale:\n${incomplete.join("\n")}`,
  );
  process.exit(1);
}

const urlOf = (localeCode, pagePath) =>
  `${siteUrl}${LOCALES.find((l) => l.code === localeCode)?.prefix ?? ""}${pagePath}`;

const entries = routes.map((route) => {
  const locale = localeOf(route);
  const pagePath = locale.prefix ? route.slice(locale.prefix.length) : route;
  const variants = byPage.get(pagePath);

  const alternates =
    variants.size > 1
      ? [
          ...LOCALES.filter((l) => variants.has(l.code)).map(
            (l) =>
              `    <xhtml:link rel="alternate" hreflang="${l.hreflang}" href="${urlOf(l.code, pagePath)}"/>`,
          ),
          `    <xhtml:link rel="alternate" hreflang="x-default" href="${urlOf("en", pagePath)}"/>`,
        ]
      : [];

  return ["  <url>", `    <loc>${siteUrl}${route}</loc>`, ...alternates, "  </url>"].join("\n");
});

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ...entries,
  "</urlset>",
  "",
].join("\n");

writeFileSync(outFile, xml);
console.log(`sitemap.xml: ${routes.length} pages`);
