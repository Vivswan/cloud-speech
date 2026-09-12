#!/usr/bin/env node
// The one entry point for the static checks: `bun run check[:fix]`, the husky pre-commit hook, and CI.
// Typography confusables are not here; the fleet's check-typography action runs in the central CI that
// ci.yml calls.

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
run("bun", ["scripts/check-yaml.mts"]);
run("bun", ["scripts/check-biome-schema.mts"]);
run("bun", ["scripts/check-sync.mts"]);
run("bun", ["scripts/check-compat.mts"]);
run("bun", ["scripts/check-bun-pin.mts"]);
run("bunx", ["knip"]);

console.log("All checks passed.");
