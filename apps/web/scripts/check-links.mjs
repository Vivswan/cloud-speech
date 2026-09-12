#!/usr/bin/env bun
// Build assertions on the URLs the built pages carry; runs after `astro build` (the build script in package.json).
//   empty href           -> the browser resolves href="" to the page itself; the StoreListing union in
//                           packages/constants forces a `status` narrow, this catches what types cannot see
//   dev-only URL         -> localhost, .output/, or the local store-screenshots/ prefix bakes the `astro dev`
//                           decision (src/lib/screenshot-source.ts) into a build
//   same-site dead link  -> a URL under the site base must name a built file or a directory with index.html;
//                           the Pages pipeline checks this only on main after the merge, this catches it on the PR

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { siteBase, siteOrigin } from "../src/lib/pages-tier.ts";
import { STORE_SCREENSHOTS_DIR } from "../src/lib/screenshot-source.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(webRoot, "dist");

/** The prefixes the dev server serves the local render under (src/lib/dev-screenshots.ts). */
const LOCAL_SCREENSHOTS = [
  `${STORE_SCREENSHOTS_DIR}/`,
  `/${STORE_SCREENSHOTS_DIR}/`,
  `${siteBase}${STORE_SCREENSHOTS_DIR}/`,
];

function devOnlyUrl(html) {
  for (const [, url] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    if (url.includes("localhost") || url.includes(".output/")) return url;
    if (LOCAL_SCREENSHOTS.some((prefix) => url.startsWith(prefix))) return url;
  }
  return undefined;
}

const origin = new URL(siteOrigin).origin;

/** URL.parse resolves the link as the browser does (dot segments, percent-encoding, this origin's spellings).
 *  Unparseable or undecodable input comes back as written so resolvesInDist reports it instead of skipping it. */
function sameSitePath(url, pagePath) {
  const target = URL.parse(url, `${origin}${pagePath}`);
  if (target === null) return url;
  if (target.origin !== origin) return undefined;
  try {
    return decodeURIComponent(target.pathname);
  } catch {
    return url;
  }
}

/** A path outside this build's site base is reported dead: it may name another Pages tier (src/lib/pages-tier.ts),
 *  but this build cannot verify it. A decoded path that climbs out of dist is dead too. */
function resolvesInDist(sitePath) {
  if (!sitePath.startsWith(siteBase)) return false;
  const target = join(distDir, sitePath.slice(siteBase.length));
  if (relative(distDir, target).startsWith("..")) return false;
  if (existsSync(target) && statSync(target).isFile()) return true;
  return existsSync(join(target, "index.html"));
}

const emptyHrefs = [];
const devUrls = [];
const deadLinks = [];
for (const entry of readdirSync(distDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
  const file = resolve(entry.parentPath, entry.name);
  const page = relative(distDir, file);
  const html = readFileSync(file, "utf8");
  if (/\bhref=(""|'')/.test(html)) emptyHrefs.push(page);
  const url = devOnlyUrl(html);
  if (url !== undefined) devUrls.push(`${page}: ${url}`);
  const pagePath = siteBase + page.split(sep).join("/");
  for (const [, link] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    const sitePath = sameSitePath(link, pagePath);
    if (sitePath !== undefined && !resolvesInDist(sitePath)) deadLinks.push(`${page}: ${link}`);
  }
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
if (deadLinks.length > 0) {
  failed = true;
  console.error(
    `check-links: ${deadLinks.length} same-site link(s) resolve to nothing in dist:\n` +
      deadLinks.map((line) => `  ${line}`).join("\n"),
  );
}
if (failed) process.exit(1);
console.log(
  "check-links: no empty hrefs, no dev-only URLs, and every same-site link resolves in dist",
);
