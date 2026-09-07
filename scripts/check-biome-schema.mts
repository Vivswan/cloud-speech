#!/usr/bin/env bun
// Fails `bun run check` when a Biome config's `$schema` pin lags the installed
// CLI. Dependabot bumps @biomejs/biome but not the schema URLs, and Biome then
// prints a "run biome migrate" info on every check without failing it, so the
// drift used to sit there until someone noticed. Run: bun scripts/check-biome-schema.mts

import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "./lib/report.mts";
import { walk } from "./lib/walk.mts";

const CONFIG_NAMES = new Set(["biome.json", "biome.jsonc"]);
const SCHEMA_URL = /^https:\/\/biomejs\.dev\/schemas\/([^/]+)\/schema\.json$/;

function installedVersion(root: string): string {
  const pkg = JSON.parse(
    readFileSync(join(root, "node_modules/@biomejs/biome/package.json"), "utf-8"),
  ) as { version: string };
  return pkg.version;
}

/** Every Biome config under `root`: `checked` lists the ones pinned to the
 *  installed version, `inspected` counts all of them, findings name the rest. */
function scanTree(root: string): {
  inspected: number;
  installed: string;
  checked: string[];
  findings: string[];
} {
  const installed = installedVersion(root);
  const findings: string[] = [];
  const checked: string[] = [];
  let inspected = 0;
  for (const path of walk(root, { extensions: [".json", ".jsonc"] })) {
    if (!CONFIG_NAMES.has(basename(path))) continue;
    inspected++;
    const rel = relative(root, path);
    // Bun.JSONC so biome.jsonc (comments, trailing commas) parses like biome.json.
    const schema: unknown = Bun.JSONC.parse(readFileSync(path, "utf-8")).$schema;
    const found = typeof schema === "string" ? schema.match(SCHEMA_URL)?.[1] : undefined;
    if (found === undefined) {
      findings.push(
        `${rel}: $schema is ${JSON.stringify(schema)}, expected a biomejs.dev schema URL`,
      );
    } else if (found !== installed) {
      findings.push(
        `${rel}: $schema is ${found}, installed biome is ${installed}; run biome migrate --write`,
      );
    } else {
      checked.push(rel);
    }
  }
  return { inspected, installed, checked, findings };
}

runCheck(import.meta.url, {
  scan: () => scanTree(fileURLToPath(new URL("..", import.meta.url))),
  empty: "no biome.json or biome.jsonc found under the repo root",
  failed: (count) => `${count} Biome $schema pin(s) off the installed CLI`,
  passed: ({ installed, checked }) =>
    `Biome schema check passed (${installed}): ${checked.join(", ")}`,
});
