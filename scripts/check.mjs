#!/usr/bin/env node
// Single entry point for the repo's static checks: biome (lint + format),
// typography look-alikes, and yamllint. Used by `bun run check[:fix]`, the
// husky pre-commit hook, and CI. Pass --fix to let biome write fixes.

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
run("bun", ["scripts/check-typography.mjs"]);

const yamllint = spawnSync("yamllint", ["--version"], { stdio: "ignore" });
if (yamllint.error) {
  console.error(
    "yamllint is missing. Install it with 'brew install yamllint' (or 'pipx install yamllint').",
  );
  process.exit(1);
}
run("yamllint", ["-s", "."]);

console.log("All checks passed.");
