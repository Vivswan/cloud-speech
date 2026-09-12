#!/usr/bin/env bun
// Writes dist/sitemap.xml after `astro build` (the build script in package.json) from src/pages/ and
// packages/constants, so neither the page list nor the site URL is restated here. Each entry's xhtml:link
// alternates mirror the hreflang links Base.astro puts in every <head>, x-default -> English included.

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LOCALES } from "../src/i18n/locales.ts";
import { isIndexableTier, siteBase, siteOrigin } from "../src/lib/pages-tier.ts";

const siteUrl = `${siteOrigin}${siteBase}`;

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pagesDir = resolve(webRoot, "src/pages");
const outFile = resolve(webRoot, "dist/sitemap.xml");

// The noindexed tiers (Base.astro) ship no sitemap: it would only advertise URLs crawlers are told to ignore.
if (!isIndexableTier) {
  console.log(`sitemap.xml: skipped (${process.env.PAGES_TIER} tier)`);
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

const byPage = new Map();
for (const route of routes) {
  const locale = localeOf(route);
  const pagePath = locale.prefix ? route.slice(locale.prefix.length) : route;
  if (!byPage.has(pagePath)) byPage.set(pagePath, new Set());
  byPage.get(pagePath).add(locale.code);
}

// Base.astro emits hreflang links to every locale's variant of each page, so a page missing from one tree
// ships broken alternates; fail the build instead.
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
