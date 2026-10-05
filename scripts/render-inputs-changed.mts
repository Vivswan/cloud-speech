#!/usr/bin/env bun
// Which store-screenshot render inputs a pull request changed: the roster in scripts/lib/render-inputs.mts, plus the
// check's own two files, since a change to the job or its action must prove the render still runs. A git failure
// exits with git's status rather than reading as "nothing changed".
//
//   bun scripts/render-inputs-changed.mts <base-commit> <head-commit>

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { RENDER_INPUTS } from "./lib/render-inputs.mts";

const CHECK_INPUTS = [".github/workflows/checks.yml", ".github/actions/render-store-screenshots"];

const [base, head] = process.argv.slice(2);
if (base === undefined || head === undefined || process.argv.length !== 4) {
  console.error("usage: bun scripts/render-inputs-changed.mts <base-commit> <head-commit>");
  process.exit(2);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const diff = spawnSync(
  "git",
  ["diff", "--name-only", base, head, "--", ...RENDER_INPUTS, ...CHECK_INPUTS],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
);
if (diff.status !== 0) process.exit(diff.status ?? 1);
process.stdout.write(diff.stdout);
