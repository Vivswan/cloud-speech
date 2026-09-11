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
//      .output/ path, or the local store-screenshots/ path (bare, rooted, or
//      under the site base) has the dev decision baked in. The published
//      set's URL and links to the store-screenshots branch on GitHub are
//      fine: only the local forms are dev-only.
//   3. Every same-site URL resolves to a file in dist: a rooted or absolute
//      URL under the site base, or a relative one, must name a built file or
//      a directory with an index.html. The Pages pipeline checks the same
//      thing after assembling the whole site, but that runs on main after
//      the merge; this catches a link to a route Astro never emits (the 404
//      page's own directory route once carried its canonical) on the PR.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { siteBase, siteOrigin } from "../src/lib/pages-tier.ts";
import { STORE_SCREENSHOTS_DIR } from "../src/lib/screenshot-source.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(webRoot, "dist");

/** The local render's URL prefixes, as the dev server would serve them. */
const LOCAL_SCREENSHOTS = [
  `${STORE_SCREENSHOTS_DIR}/`,
  `/${STORE_SCREENSHOTS_DIR}/`,
  `${siteBase}${STORE_SCREENSHOTS_DIR}/`,
];

/** The dev-only URL a built page must not carry, or undefined. */
function devOnlyUrl(html) {
  for (const [, url] of html.matchAll(/\b(?:href|src)="([^"]*)"/g)) {
    if (url.includes("localhost") || url.includes(".output/")) return url;
    if (LOCAL_SCREENSHOTS.some((prefix) => url.startsWith(prefix))) return url;
  }
  return undefined;
}

const origin = new URL(siteOrigin).origin;

/** The site-rooted path a URL on the page at `pagePath` (the page's
 *  site-rooted path) names, resolved and normalized the way the browser
 *  does (dot segments, percent-encoding, protocol-relative and absolute
 *  spellings of this origin); undefined for another origin or a non-http
 *  scheme. A URL that cannot be parsed or decoded is returned as written so
 *  it fails resolution. */
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

/** Whether a site-rooted path is served from dist: the file itself, or the
 *  directory's index.html (with or without the trailing slash). A path
 *  outside the site base, or one whose decoded dot segments climb out of
 *  dist, is dead: GitHub Pages serves nothing there. */
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
