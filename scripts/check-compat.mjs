#!/usr/bin/env bun
// Backwards-compatibility code lives ONLY in apps/extension/src/migrations/.
// This scans every other extension source file for the vocabulary such code
// carries and fails on any hit, so an "old shape" branch cannot quietly grow
// outside the folder. Import specifiers pointing into @/migrations are
// exempt (the wiring must name the folder). Bare "compat" is deliberately
// NOT matched: "OpenAI-compatible" is product prose.
// Runs in `bun run check` (scripts/check.mjs).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_ROOT = join(ROOT, "apps/extension/src");
const EXEMPT_DIR = join(SCAN_ROOT, "migrations");

const COMPAT_TOKEN =
  /\blegacy\b|\bdeprecated\b|\bbackwards?[ -]compat|\bold (format|shape|schema|keys?)\b|\bmigrat(e|ed|ion|ions)\b/i;
const MIGRATIONS_IMPORT = /(["'])@\/migrations(?:\/[^"']*)?\1/g;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (path !== EXEMPT_DIR) yield* walk(path);
    } else if (/\.tsx?$/.test(entry)) {
      yield path;
    }
  }
}

/** The offending token in `line`, or null. */
function compatToken(line) {
  const match = COMPAT_TOKEN.exec(line.replace(MIGRATIONS_IMPORT, ""));
  return match ? match[0] : null;
}

const hits = [];
let scanned = 0;
for (const file of walk(SCAN_ROOT)) {
  scanned++;
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, index) => {
    const token = compatToken(line);
    if (token) hits.push(`${relative(ROOT, file)}:${index + 1}: ${token}`);
  });
}

// A scan that found no source files is a broken scan root, not a clean tree.
if (scanned === 0) {
  console.error(`x no TypeScript sources found under ${relative(ROOT, SCAN_ROOT)}`);
  process.exit(1);
}
if (hits.length > 0) {
  for (const hit of hits) console.error(`x ${hit}`);
  console.error(
    `\n${hits.length} compatibility token(s) outside apps/extension/src/migrations/ (move the code there)`,
  );
  process.exit(1);
}
console.log(`Compatibility-code placement check passed (${scanned} files).`);
