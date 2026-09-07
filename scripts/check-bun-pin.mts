#!/usr/bin/env bun
// The bun version is written down ONCE, in .bun-version (managed by
// repo-platform): every setup-bun step in .github/workflows reads that file,
// and package.json carries no packageManager. Corepack does not manage bun, so
// that field is only ever a second pin that setup-bun alone could read; when
// the two disagreed, CI ran an older bun that could not parse the lockfile
// developers wrote. Runs in `bun run check` (scripts/check.mjs); the scan is
// unit-tested from apps/extension/tests/scripts/check-bun-pin.test.ts.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const WORKFLOWS_DIR = ".github/workflows";
const PIN_FILE = ".bun-version";
const SETUP_BUN = "oven-sh/setup-bun@";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every setup-bun step in one workflow's text: how many there are and, as
 *  `path: job <name> step <n>: <problem>`, the ones not reading PIN_FILE. */
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
      if (inputs.has("bun-version")) {
        findings.push(
          `${where}: sets bun-version; read the pin with bun-version-file: ${PIN_FILE}`,
        );
      }
      const file = inputs.get("bun-version-file");
      if (file !== PIN_FILE) {
        findings.push(
          `${where}: bun-version-file is ${JSON.stringify(file)}, expected ${PIN_FILE}`,
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

/** The whole repository: every workflow file plus the root package.json. */
export function scanRepo(root: string): { steps: number; findings: string[] } {
  const dir = join(root, WORKFLOWS_DIR);
  let steps = 0;
  const findings: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(entry)) continue;
    const path = join(WORKFLOWS_DIR, entry);
    const result = workflowFindings(path, readFileSync(join(root, path), "utf8"));
    steps += result.steps;
    findings.push(...result.findings);
  }
  findings.push(...packageJsonFindings(readFileSync(join(root, "package.json"), "utf8")));
  return { steps, findings };
}

function main(): void {
  const { steps, findings } = scanRepo(fileURLToPath(new URL("..", import.meta.url)));
  // A scan that saw no setup-bun step is a broken scan, not a clean tree.
  if (steps === 0) {
    console.error(`x no setup-bun steps found under ${WORKFLOWS_DIR}`);
    process.exit(1);
  }
  if (findings.length > 0) {
    for (const finding of findings) console.error(`x ${finding}`);
    console.error(`\n${findings.length} bun pin(s) outside ${PIN_FILE}`);
    process.exit(1);
  }
  console.log(`Bun pin check passed (${steps} setup-bun steps read ${PIN_FILE}).`);
}

// Under Vitest the module URL is not file:-scheme and argv[1] is the runner.
const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url.startsWith("file:") &&
  resolve(entry) === fileURLToPath(import.meta.url)
) {
  main();
}
