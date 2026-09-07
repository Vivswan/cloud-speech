#!/usr/bin/env bun
// Fails `bun run check` when a Biome config's `$schema` pin lags the installed
// CLI. Dependabot bumps @biomejs/biome but not the schema URLs, and Biome then
// prints a "run biome migrate" info on every check without failing it, so the
// drift used to sit there until someone noticed. Run: bun scripts/check-biome-schema.mjs

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".output",
  ".wxt",
  ".astro",
  "dist",
  "coverage",
  "sources",
  ".claude",
]);
const SCHEMA_URL = /^https:\/\/biomejs\.dev\/schemas\/([^/]+)\/schema\.json$/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(path);
    } else if (entry === "biome.json" || entry === "biome.jsonc") {
      yield path;
    }
  }
}

const installed = JSON.parse(
  readFileSync(join(ROOT, "node_modules/@biomejs/biome/package.json"), "utf-8"),
).version;

const failures = [];
const checked = [];
for (const path of walk(ROOT)) {
  const rel = relative(ROOT, path);
  // Bun.JSONC so biome.jsonc (comments, trailing commas) parses like biome.json.
  const schema = Bun.JSONC.parse(readFileSync(path, "utf-8")).$schema;
  const found = typeof schema === "string" ? schema.match(SCHEMA_URL)?.[1] : undefined;
  if (found === undefined) {
    failures.push(
      `${rel}: $schema is ${JSON.stringify(schema)}, expected a biomejs.dev schema URL`,
    );
  } else if (found !== installed) {
    failures.push(
      `${rel}: $schema is ${found}, installed biome is ${installed}; run biome migrate --write`,
    );
  } else {
    checked.push(rel);
  }
}

if (checked.length === 0 && failures.length === 0) {
  failures.push("no biome.json or biome.jsonc found under the repo root");
}
if (failures.length > 0) {
  console.error("Biome schema check failures:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(`Biome schema check passed (${installed}): ${checked.join(", ")}`);
