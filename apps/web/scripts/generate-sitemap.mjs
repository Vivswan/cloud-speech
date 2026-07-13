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
import { SITE_URL } from "@cloud-speech/constants";
import { LOCALES } from "../src/i18n/locales.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pagesDir = resolve(webRoot, "src/pages");
const outFile = resolve(webRoot, "dist/sitemap.xml");

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
  `${SITE_URL}${LOCALES.find((l) => l.code === localeCode)?.prefix ?? ""}${pagePath}`;

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

  return ["  <url>", `    <loc>${SITE_URL}${route}</loc>`, ...alternates, "  </url>"].join("\n");
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
