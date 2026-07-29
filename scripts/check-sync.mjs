#!/usr/bin/env bun
// Sync assertions for files that TypeScript imports cannot reach: Markdown,
// GitHub templates, and package manifests that restate values whose single
// source is packages/constants. Assert-only, never rewrites: settings.yml is
// managed by repo-platform and the issue templates keep GitHub's own YAML
// style. Runs in `bun run check` (scripts/check.mjs). Runs under bun (not
// node) so it can import the shared TS constants.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SHORTCUTS, SITE_URL, shortcutDisplay } from "../packages/constants/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
const fail = (message) => {
  console.error(`x ${message}`);
  failures++;
};

const countOccurrences = (text, needle) => text.split(needle).length - 1;

const assertContains = (path, needle, what) => {
  const text = readFileSync(resolve(root, path), "utf8");
  if (!text.includes(needle)) {
    fail(`${path}: expected ${what} "${needle}" (constants drifted or the file did)`);
  }
};

/** Exact occurrence counts, so a location silently losing (or gaining) a
 *  restatement fails instead of passing vacuously off the remaining copies. */
const assertCount = (path, needle, expected, what) => {
  const found = countOccurrences(readFileSync(resolve(root, path), "utf8"), needle);
  if (found !== expected) {
    fail(`${path}: expected ${expected}x ${what} "${needle}", found ${found}`);
  }
};

// --- Keyboard shortcuts: README shows the display renderings of SHORTCUTS
// (the same derivation the website uses via shortcutDisplay).
assertContains("README.md", shortcutDisplay(SHORTCUTS.readAloud), "read-aloud shortcut");
assertContains("README.md", shortcutDisplay(SHORTCUTS.download), "download shortcut");

// --- Site URL: every out-of-graph restatement must carry the production
// URL from SITE_URL (links deeper into the site start with it). Counts pin
// the known locations: README badge + intro + support; config.yml's setup
// and troubleshooting contact links; bug_report.yml's troubleshooting link.
assertCount("README.md", SITE_URL, 3, "site URL");
assertCount(".github/ISSUE_TEMPLATE/config.yml", SITE_URL, 2, "site URL");
assertCount(".github/ISSUE_TEMPLATE/bug_report.yml", SITE_URL, 1, "site URL");
// The managed settings file pins the repo homepage to the site URL exactly.
// (When repo-platform carries a central settings/repos/cloud-speech.yml, that
// file wins over this one; this pins the in-repo fallback only.)
assertContains(".github/settings.yml", `homepage: "${SITE_URL}"`, "homepage");
// The web package description names the site (schemeless prose).
assertContains(
  "apps/web/package.json",
  SITE_URL.replace(/^https:\/\//, "").replace(/\/$/, ""),
  "site host/path",
);

if (failures > 0) {
  console.error(`\n${failures} constants sync failure(s)`);
  process.exit(1);
}
console.log("Constants sync checks passed.");
