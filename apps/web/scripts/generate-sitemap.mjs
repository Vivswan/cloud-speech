#!/usr/bin/env bun
// Generate dist/sitemap.xml from the actual page files — the page list and
// the site URL each live in exactly one place (src/pages/ and
// packages/constants), so the sitemap can never drift again.
// Runs after `astro build` (see the build script in package.json).

import { readdirSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_URL } from "@cloud-speech/constants";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pagesDir = resolve(webRoot, "src/pages");
const outFile = resolve(webRoot, "dist/sitemap.xml");

const pages = readdirSync(pagesDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".astro"))
  .map((entry) => relative(pagesDir, resolve(entry.parentPath, entry.name)))
  .filter((page) => page !== "404.astro")
  .map((page) => {
    const route = page.replace(/\.astro$/, "");
    return route === "index" ? "" : `${route}/`;
  })
  .sort();

const xml = [
  '<?xml version="1.0" encoding="UTF-8"?>',
  '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
  ...pages.map((page) => `  <url><loc>${SITE_URL}${page}</loc></url>`),
  "</urlset>",
  "",
].join("\n");

writeFileSync(outFile, xml);
console.log(`sitemap.xml: ${pages.length} pages`);
