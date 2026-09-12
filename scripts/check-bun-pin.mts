#!/usr/bin/env bun
// The bun version is written down ONCE, in .bun-version (the fleet sync's file): corepack does not
// manage bun, so a package.json packageManager is only a second pin that setup-bun alone could read,
// and when the two disagreed CI ran an older bun that could not parse the lockfile developers wrote.
//   repo-owned setup-bun step    -> `bun-version-file: .bun-version`, or an exact `bun-version: "x.y.z"`
//                                   as AGENTS.md allows
//   managed workflow             -> skipped; its inputs are the sync's to set
//   package.json packageManager  -> a finding

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { runCheck } from "./lib/report.mts";

const WORKFLOWS_DIR = ".github/workflows";
const PIN_FILE = ".bun-version";
const SETUP_BUN = "oven-sh/setup-bun@";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
// The template's literal first line; a repo-owned header that merely mentions the managed files it works
// with does not match.
const MANAGED_HEADER = /^# This file is managed by Vivswan\/repo-platform\./;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isManagedWorkflow(text: string): boolean {
  return MANAGED_HEADER.test(text);
}

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

export function packageJsonFindings(text: string): string[] {
  const pkg: unknown = JSON.parse(text);
  if (!isRecord(pkg) || !("packageManager" in pkg)) return [];
  return [
    `package.json: packageManager ${JSON.stringify(pkg.packageManager)} is a second bun pin; ${PIN_FILE} is the only one`,
  ];
}

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
