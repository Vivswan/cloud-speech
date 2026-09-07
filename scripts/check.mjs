#!/usr/bin/env node
// Single entry point for the repo's static checks: biome (lint + format),
// YAML style, the Biome schema pin (check-biome-schema.mjs), constants-sync
// assertions (check-sync.mjs), the compatibility-code placement scan
// (check-compat.mts), the single-bun-pin check (check-bun-pin.mts), and knip
// (unused files, exports, and dependencies; config in knip.jsonc). Used by
// `bun run check[:fix]`, the husky pre-commit hook, and CI. Pass --fix to
// let biome write fixes. Typography look-alikes are checked in CI by
// repo-platform's check-typography action (the managed `typography` job in
// ci.yml).

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fix = process.argv.includes("--fix");

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: ROOT });
  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("bunx", ["biome", "check", ...(fix ? ["--write"] : []), "."]);
run("bun", ["scripts/check-yaml.mjs"]);
run("bun", ["scripts/check-biome-schema.mjs"]);
run("bun", ["scripts/check-sync.mjs"]);
run("bun", ["scripts/check-compat.mts"]);
run("bun", ["scripts/check-bun-pin.mts"]);
run("bunx", ["knip"]);

console.log("All checks passed.");
