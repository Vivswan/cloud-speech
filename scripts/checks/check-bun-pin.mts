#!/usr/bin/env bun
// The bun version is written down ONCE, in .bun-version (the fleet sync's file): corepack does not
// manage bun, so a package.json packageManager is only a second pin that setup-bun alone could read,
// and when the two disagreed CI ran an older bun that could not parse the lockfile developers wrote.
//   repo-owned setup-bun step    -> `bun-version-file: .bun-version`, or an exact `bun-version: "x.y.z"`
//                                   as AGENTS.md allows; in a workflow or a composite action alike
//   managed file                 -> skipped; its inputs are the sync's to set
//   package.json packageManager  -> a finding

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "pathe";
import { parse } from "yaml";
import { isRecord } from "../lib/records.mts";
import { runCheck } from "../lib/report.mts";
import { walk } from "../lib/walk.mts";

const GITHUB_DIR = ".github";
/** Where Actions reads steps from: a workflow, or a composite action's manifest. */
const STEP_FILES = /^\.github\/(?:workflows\/[^/]+|actions\/[^/]+\/action)\.ya?ml$/;
const PIN_FILE = ".bun-version";
const SETUP_BUN = "oven-sh/setup-bun@";
const EXACT_VERSION = /^\d+\.\d+\.\d+$/;
// The template's literal first line; a repo-owned header that merely mentions the managed files it works
// with does not match.
const MANAGED_HEADER = /^# This file is managed by Vivswan\/repo-platform\./;

/** Each step list in the document under the label its findings cite: a workflow's jobs, a composite
 *  action's `runs`. */
function stepLists(doc: unknown): [string, unknown[]][] {
  if (!isRecord(doc)) return [];
  const lists: [string, unknown[]][] = [];
  for (const [jobName, job] of Object.entries(isRecord(doc.jobs) ? doc.jobs : {})) {
    if (isRecord(job) && Array.isArray(job.steps)) lists.push([`job ${jobName}`, job.steps]);
  }
  if (isRecord(doc.runs) && Array.isArray(doc.runs.steps)) lists.push(["runs", doc.runs.steps]);
  return lists;
}

export function pinFindings(path: string, text: string): { steps: number; findings: string[] } {
  const findings: string[] = [];
  let steps = 0;
  for (const [list, listSteps] of stepLists(parse(text))) {
    listSteps.forEach((step: unknown, index) => {
      // Actions matches the owner/repo and input names case-insensitively.
      if (!isRecord(step) || typeof step.uses !== "string") return;
      if (!step.uses.toLowerCase().startsWith(SETUP_BUN)) return;
      steps++;
      const where = `${path}: ${list} step ${index + 1}`;
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
  let inspected = 0;
  let skipped = 0;
  const findings: string[] = [];
  // An empty skip list: an action directory may be named dist or coverage. pathe's relative is
  // slash-separated on every host, as STEP_FILES and the findings read paths.
  const paths = walk(join(root, GITHUB_DIR), { extensions: [".yml", ".yaml"], skip: new Set() })
    .map((absolute) => relative(root, absolute))
    .filter((path) => STEP_FILES.test(path));
  for (const path of paths) {
    const text = readFileSync(join(root, path), "utf8");
    if (MANAGED_HEADER.test(text)) {
      skipped++;
      continue;
    }
    const result = pinFindings(path, text);
    inspected += result.steps;
    findings.push(...result.findings);
  }
  findings.push(...packageJsonFindings(readFileSync(join(root, "package.json"), "utf8")));
  return { inspected, skipped, findings };
}

if (import.meta.main) {
  await runCheck({
    scan: () => scanRepo(fileURLToPath(new URL("../..", import.meta.url))),
    empty: `no setup-bun steps found in repo-owned workflows or composite actions under ${GITHUB_DIR}`,
    failed: (count) => `${count} bun pin(s) outside ${PIN_FILE}`,
    passed: ({ inspected, skipped }) =>
      `Bun pin check passed (${inspected} repo-owned setup-bun steps checked, ${skipped} managed files skipped).`,
  });
}
