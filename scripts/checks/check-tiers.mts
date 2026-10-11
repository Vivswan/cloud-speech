#!/usr/bin/env bun
// Every test file's first line names its tier (`// tier: pr`), and the tier is the one a workflow of this
// repository runs the file under. No runner reads the header, so a missing one or a tier no workflow
// runs the file under would mislabel the test silently; this census is what notices.
//
//   pr            -> checks.yml, every PR and push to main: vitest, playwright, and bun test
//   release-gate  -> release-gate.yml, the release PR, a dispatch, and the nightly: the deep fuzz, which
//                    re-runs `*-fuzz.test.ts` (pr files) under a larger budget, so no file is its own
//   nightly       -> no workflow here runs tests under it
//
// Every runner selects its files by path, and every runner runs in checks.yml, so every test file is
// `pr`. A file of another tier first needs a runner that selects it by tier; that runner's rule goes here.

import { readFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "../lib/report.mts";
import { walk } from "../lib/walk.mts";

/** Relative to the repository root the caller supplies: tests import this module with their own root. */
const SCAN_DIR = "apps";
const SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];
/** The union of what vitest, Playwright, and bun test select by default, so no runner picks up a file this
 *  census never saw: `.test.` or `.spec.` (all three), and bun's `_test.` and `_spec.` as well. */
const TEST_FILE = /[._](test|spec)\.[cm]?[jt]sx?$/;
const HEADER = /^\/\/ tier: (\S+)$/;
const TIERS = ["pr", "release-gate", "nightly"] as const;
type Tier = (typeof TIERS)[number];
const RUN_TIER: Tier = "pr";
const RUN_BY = "checks.yml runs it on every PR";

export function tierFinding(firstLine: string): string | null {
  const match = HEADER.exec(firstLine);
  if (!match) return `no tier header (first line must be "// tier: <${TIERS.join("|")}>")`;
  const tier = match[1];
  if (!TIERS.includes(tier as Tier)) return `unknown tier "${tier}" (one of ${TIERS.join(", ")})`;
  if (tier !== RUN_TIER)
    return `tier "${tier}", but ${RUN_BY} (${RUN_TIER}); no runner selects by tier`;
  return null;
}

export function scanTree(root: string): { inspected: number; findings: string[] } {
  const findings: string[] = [];
  let inspected = 0;
  for (const file of walk(join(root, SCAN_DIR), { extensions: SOURCE_EXTENSIONS })) {
    if (!TEST_FILE.test(basename(file))) continue;
    inspected++;
    const firstLine = readFileSync(file, "utf8").split("\n", 1)[0] ?? "";
    const finding = tierFinding(firstLine);
    if (finding) findings.push(`${relative(root, file)}:1: ${finding}`);
  }
  return { inspected, findings };
}

await runCheck(import.meta.url, {
  scan: () => scanTree(fileURLToPath(new URL("../..", import.meta.url))),
  empty: `no test files found under ${SCAN_DIR} (${TEST_FILE})`,
  failed: (count) => `${count} test file(s) without an accepted tier header (the rule is above)`,
  passed: ({ inspected }) => `Test tier census passed (${inspected} files).`,
});
