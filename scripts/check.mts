#!/usr/bin/env bun
// The one entry point for the static checks: `bun run check[:fix]`, the husky pre-commit hook, and CI.
// Not here: what the fleet CI (ci.yml's `ci` job) runs on every PR: typography confusables, yamllint, and
// knip, which the pre-commit hook runs on its own so a local run still catches it.

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const fix = process.argv.includes("--fix");

function run(command: string, args: readonly string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit", cwd: ROOT });
  if (result.error) {
    console.error(`Failed to run ${command}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("bun", ["run", "biome", "check", ...(fix ? ["--write"] : []), "."]);
run("bun", ["scripts/check-yaml.mts"]);
run("bun", ["scripts/check-biome-schema.mts"]);
run("bun", ["scripts/check-sync.mts"]);
run("bun", ["scripts/check-compat.mts"]);
run("bun", ["scripts/check-bun-pin.mts"]);

console.log("All checks passed.");
