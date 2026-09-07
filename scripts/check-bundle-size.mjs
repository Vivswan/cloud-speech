#!/usr/bin/env bun
// Bundle-size tripwire for the built extension. The content script is
// injected into EVERY page the user opens, so it must stay tiny: pulling the
// protocol registry (Zod plus every route table) into it once made it 19x
// larger, which no test noticed. Runs after each browser build:
//   bun scripts/check-bundle-size.mjs chrome-mv3 [firefox-mv3 ...]

import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = resolve(root, "apps/extension/.output");

/** Output file (relative to a browser build dir) -> maximum size in bytes. */
const LIMITS = {
  "content-scripts/content.js": 16 * 1024,
};

const builds = process.argv.slice(2);
if (builds.length === 0) {
  console.error("usage: bun scripts/check-bundle-size.mjs <build-dir> [<build-dir> ...]");
  process.exit(2);
}

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;

let failures = 0;
for (const build of builds) {
  for (const [file, limit] of Object.entries(LIMITS)) {
    const path = resolve(outDir, build, file);
    let size;
    try {
      size = statSync(path).size;
    } catch {
      console.error(`✗ ${build}/${file}: missing (did the build run?)`);
      failures++;
      continue;
    }
    if (size > limit) {
      console.error(`✗ ${build}/${file}: ${kb(size)} exceeds the ${kb(limit)} limit`);
      failures++;
    } else {
      console.log(`✓ ${build}/${file}: ${kb(size)} (limit ${kb(limit)})`);
    }
  }
}

if (failures > 0) {
  console.error(`\n${failures} bundle size failure(s)`);
  process.exit(1);
}
