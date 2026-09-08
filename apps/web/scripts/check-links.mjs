#!/usr/bin/env bun
// Build assertions on the URLs the built pages carry. Runs after `astro build`
// (see the build script in package.json).
//   1. No empty href: the browser resolves href="" to the page itself, a
//      self-linking anchor. The StoreListing union in packages/constants
//      forces TypeScript consumers to narrow on `status` before touching a
//      URL; this scan is the backstop for anything the type system can't see.
//   2. No dev-only URL: the walkthrough page loads its screenshots from the
//      local render under <base>/store-screenshots/ in `astro dev` and from
//      the published set (raw.githubusercontent.com) in a build
//      (src/lib/screenshot-source.ts). A built page pointing at localhost, a
//      .output/ path, or a store-screenshots/ path that is not the published
//      URL has the dev decision baked in.

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(webRoot, "dist");

const PUBLISHED_SCREENSHOTS = "https://raw.githubusercontent.com/";

/** The dev-only URL a built page must not carry, or undefined. */
function devOnlyUrl(html) {
  for (const [, url] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    if (url.includes("localhost") || url.includes(".output/")) return url;
    if (url.includes("store-screenshots/") && !url.startsWith(PUBLISHED_SCREENSHOTS)) return url;
  }
  return undefined;
}

const emptyHrefs = [];
const devUrls = [];
for (const entry of readdirSync(distDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
  const file = resolve(entry.parentPath, entry.name);
  const html = readFileSync(file, "utf8");
  if (/\bhref=(""|'')/.test(html)) emptyHrefs.push(relative(distDir, file));
  const url = devOnlyUrl(html);
  if (url !== undefined) devUrls.push(`${relative(distDir, file)}: ${url}`);
}

let failed = false;
if (emptyHrefs.length > 0) {
  failed = true;
  console.error(
    `check-links: ${emptyHrefs.length} built page(s) carry an empty href:\n` +
      emptyHrefs.map((file) => `  ${file}`).join("\n"),
  );
}
if (devUrls.length > 0) {
  failed = true;
  console.error(
    `check-links: ${devUrls.length} built page(s) carry a dev-only URL:\n` +
      devUrls.map((line) => `  ${line}`).join("\n"),
  );
}
if (failed) process.exit(1);
console.log("check-links: no empty hrefs and no dev-only URLs in dist");
