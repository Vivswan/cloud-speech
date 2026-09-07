#!/usr/bin/env bun
// The bun version is written down ONCE, in .bun-version (managed by
// repo-platform), and package.json carries no packageManager: corepack does
// not manage bun, so that field is only ever a second pin that setup-bun alone
// could read, and when the two disagreed CI ran an older bun that could not
// parse the lockfile developers wrote. In repo-owned workflows every setup-bun
// step therefore either reads `bun-version-file: .bun-version` or, as
// AGENTS.md allows, pins another exact version with `bun-version: "x.y.z"`;
// a bun-version-file pointing anywhere else is the drift this catches.
// Workflows whose header says "managed by Vivswan/repo-platform" are skipped:
// their inputs are repo-platform's to set. Runs in `bun run check`
// (scripts/check.mjs); unit-tested from
// apps/extension/tests/scripts/check-bun-pin.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { runCheck } from "./lib/report.mts";

const WORKFLOWS_DIR = ".github/workflows";
const PIN_FILE = ".bun-version";
const SETUP_BUN = "oven-sh/setup-bun@";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
// The template's literal first line; a repo-owned header that merely mentions
// the managed files it works with does not match.
const MANAGED_HEADER = /^# This file is managed by Vivswan\/repo-platform\./;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isManagedWorkflow(text: string): boolean {
  return MANAGED_HEADER.test(text);
}

/** Every setup-bun step in one repo-owned workflow's text: how many there are
 *  and, as `path: job <name> step <n>: <problem>`, the ones pinned wrong. */
export function workflowFindings(
  path: string,
  text: string,
): { steps: number; findings: string[] } {
  const findings: string[] = [];
  let steps = 0;
  const doc: unknown = parse(text);
  const jobs = isRecord(doc) && isRecord(doc.jobs) ? doc.jobs : {};
  for (const [jobName, job] of Object.entries(jobs)) {
    if (!isRecord(job) || !Array.isArray(job.steps)) continue;
    job.steps.forEach((step: unknown, index) => {
      // Actions matches the owner/repo and input names case-insensitively.
      if (!isRecord(step) || typeof step.uses !== "string") return;
      if (!step.uses.toLowerCase().startsWith(SETUP_BUN)) return;
      steps++;
      const where = `${path}: job ${jobName} step ${index + 1}`;
      const inputs = new Map(
        Object.entries(isRecord(step.with) ? step.with : {}).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      );
      const version = inputs.get("bun-version");
      const file = inputs.get("bun-version-file");
      if (version !== undefined && !EXACT_VERSION.test(String(version))) {
        findings.push(`${where}: bun-version ${JSON.stringify(version)} is not an exact x.y.z pin`);
      }
      if (file !== undefined && file !== PIN_FILE) {
        findings.push(
          `${where}: bun-version-file is ${JSON.stringify(file)}, expected ${PIN_FILE}`,
        );
      } else if (version === undefined && file === undefined) {
        findings.push(
          `${where}: reads no pin; set bun-version-file: ${PIN_FILE} (or a bun-version override)`,
        );
      }
    });
  }
  return { steps, findings };
}

/** The root package.json must not carry a packageManager pin. */
export function packageJsonFindings(text: string): string[] {
  const pkg: unknown = JSON.parse(text);
  if (!isRecord(pkg) || !("packageManager" in pkg)) return [];
  return [
    `package.json: packageManager ${JSON.stringify(pkg.packageManager)} is a second bun pin; ${PIN_FILE} is the only one`,
  ];
}

/** The whole repository: `inspected` counts the setup-bun steps in repo-owned
 *  workflows, `skipped` the managed workflow files left to repo-platform. */
export function scanRepo(root: string): { inspected: number; skipped: number; findings: string[] } {
  const dir = join(root, WORKFLOWS_DIR);
  let inspected = 0;
  let skipped = 0;
  const findings: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const path = join(WORKFLOWS_DIR, entry);
    const text = readFileSync(join(root, path), "utf8");
    if (isManagedWorkflow(text)) {
      skipped++;
      continue;
    }
    const result = workflowFindings(path, text);
    inspected += result.steps;
    findings.push(...result.findings);
  }
  findings.push(...packageJsonFindings(readFileSync(join(root, "package.json"), "utf8")));
  return { inspected, skipped, findings };
}

runCheck(import.meta.url, {
  scan: () => scanRepo(fileURLToPath(new URL("..", import.meta.url))),
  empty: `no setup-bun steps found in repo-owned workflows under ${WORKFLOWS_DIR}`,
  failed: (count) => `${count} bun pin(s) outside ${PIN_FILE}`,
  passed: ({ inspected, skipped }) =>
    `Bun pin check passed (${inspected} repo-owned setup-bun steps checked, ${skipped} managed workflows skipped).`,
});
