#!/usr/bin/env bun
// Mozilla's addons-linter, the validator addons.mozilla.org runs on every
// upload, run here on the built Firefox directory through web-ext (a
// devDependency of apps/extension that bundles it). An error fails the check.
// So does a warning that is not in ACCEPTED_WARNINGS below; the accepted ones
// (library code the build cannot change, and one manifest decision) only
// surface as GitHub annotations.
//
// Lints the directory rather than the store zip: WXT zips that directory
// unchanged, so the verdict is the same, and the directory has one fixed path
// while the zip carries the version in its name. Run: bun run lint:firefox
// (after bun run build:firefox); the classification is unit-tested from
// apps/extension/tests/scripts/lint-firefox.test.ts.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "./lib/report.mts";
import { walk } from "./lib/walk.mts";

const BUILD_DIR = "apps/extension/.output/firefox-mv3";
const WEB_EXT = "apps/extension/node_modules/.bin/web-ext";

/** Warnings the build is known to produce, as linter code + file (a pattern
 *  where the bundle name carries a hash). Counts do not matter: React DOM
 *  trips the same rule twice. A new library pattern joins this list with its
 *  source named; a warning in our own code is fixed instead. The file is the
 *  finest grain the linter reports, and a bundle mixes our code with its
 *  libraries, so `source` explains an entry rather than enforcing it: the
 *  same code from our own code inside an accepted bundle also passes. */
export const ACCEPTED_WARNINGS: readonly { code: string; file: RegExp; source: string }[] = [
  // wxt.config.ts declares no gecko_android while Android is unsupported.
  {
    code: "KEY_FIREFOX_ANDROID_UNSUPPORTED_BY_MIN_VERSION",
    file: /^manifest\.json$/,
    source: "manifest: no Android floor",
  },
  // Zod probes `Function("")` once to detect a CSP that forbids eval.
  { code: "DANGEROUS_EVAL", file: /^background\.js$/, source: "zod" },
  { code: "DANGEROUS_EVAL", file: /^chunks\/popup-[^/]+\.js$/, source: "zod" },
  // React DOM's innerHTML paths and React Router's dynamic import.
  {
    code: "UNSAFE_VAR_ASSIGNMENT",
    file: /^chunks\/popup-[^/]+\.js$/,
    source: "react-dom, react-router",
  },
];

export interface LinterMessage {
  _type: "error" | "warning" | "notice";
  code: string;
  message: string;
  file?: string;
  line?: number;
  column?: number;
}

export interface LinterReport {
  errors: LinterMessage[];
  warnings: LinterMessage[];
  notices: LinterMessage[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** What the process left behind when stdout holds no report: its exit status
 *  and stderr (a bad flag, a Node incompatibility, a crash). */
export interface RunOutcome {
  status: number | null;
  stderr: string;
}

const CAPTURE_LIMIT = 4096;

/** web-ext's `--output json` report, or a throw quoting what the process
 *  printed instead (stdout, and stderr with the exit status when given). */
export function parseReport(stdout: string, run?: RunOutcome): LinterReport {
  const captured = () => {
    const parts = [`stdout:\n${stdout.trim().slice(0, CAPTURE_LIMIT)}`];
    if (run) {
      parts.unshift(`exit status ${run.status ?? "(signal)"}`);
      parts.push(`stderr:\n${run.stderr.trim().slice(0, CAPTURE_LIMIT)}`);
    }
    return parts.join("\n");
  };
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`web-ext lint printed no JSON report; ${captured()}`);
  }
  const lists = ["errors", "warnings", "notices"] as const;
  if (!isRecord(parsed) || !lists.every((list) => Array.isArray(parsed[list]))) {
    throw new Error(`web-ext lint report lacks its errors/warnings/notices lists; ${captured()}`);
  }
  return parsed as unknown as LinterReport;
}

// GitHub's workflow-command escaping (actions/core): the message keeps commas
// and colons, the properties cannot.
const escapeData = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text: string) =>
  escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

/** One `::warning file=...::` line per message, so the Actions run shows it
 *  without failing; `dir` is the build directory relative to the repo root. */
export function annotation(message: LinterMessage, dir: string): string {
  const properties = [`title=${escapeProperty(message.code)}`];
  if (message.file !== undefined) {
    properties.unshift(`file=${escapeProperty(`${dir}/${message.file}`)}`);
    if (message.line !== undefined) properties.push(`line=${message.line}`);
    if (message.column !== undefined) properties.push(`col=${message.column}`);
  }
  return `::${message._type} ${properties.join(",")}::${escapeData(message.message)}`;
}

const isAccepted = (warning: LinterMessage) =>
  ACCEPTED_WARNINGS.some(
    (entry) => entry.code === warning.code && entry.file.test(warning.file ?? ""),
  );

/** The report sorted into what fails (`findings`, as `<file>:<line> <code>:
 *  <message>`: every error, plus every warning outside ACCEPTED_WARNINGS) and
 *  what only annotates (every message, findings included, so they show in the
 *  run too). */
export function classify(
  report: LinterReport,
  dir: string,
): { findings: string[]; annotations: string[] } {
  const where = (message: LinterMessage) =>
    message.file === undefined
      ? "(no file)"
      : `${dir}/${message.file}${message.line === undefined ? "" : `:${message.line}`}`;
  const describe = (message: LinterMessage) =>
    `${where(message)} ${message.code}: ${message.message}`;
  return {
    findings: [
      ...report.errors.map(describe),
      ...report.warnings
        .filter((warning) => !isAccepted(warning))
        .map(
          (warning) =>
            `${describe(warning)} (not an accepted warning: fix the code, or if a library emits it, add it to ACCEPTED_WARNINGS in scripts/lint-firefox.mts with its source named)`,
        ),
    ],
    annotations: [...report.errors, ...report.warnings, ...report.notices].map((message) =>
      annotation(message, dir),
    ),
  };
}

/** Runs web-ext lint on the build under `root`; `inspected` counts the files
 *  in that directory, so a missing or empty build fails rather than passes. */
export function lintBuild(root: string): {
  inspected: number;
  findings: string[];
  warnings: number;
} {
  const dir = resolve(root, BUILD_DIR);
  const webExt = resolve(root, WEB_EXT);
  if (!existsSync(dir)) {
    throw new Error(`${BUILD_DIR} is missing; run \`bun run build:firefox\` first.`);
  }
  if (!existsSync(webExt)) {
    throw new Error(`${WEB_EXT} is missing; run \`bun install\` first.`);
  }
  const inspected = [...walk(dir, { extensions: [""] })].length;
  if (inspected === 0) return { inspected, findings: [], warnings: 0 };

  // addons-linter exits 1 when it found errors, with the report still on
  // stdout, so the exit status is read from the report rather than the process.
  const args = [
    "lint",
    `--source-dir=${dir}`,
    "--self-hosted=false",
    "--output=json",
    "--no-input",
  ];
  const run = spawnSync(webExt, args, { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  const report = parseReport(run.stdout, { status: run.status, stderr: run.stderr });
  const { findings, annotations } = classify(report, relative(root, dir).replaceAll("\\", "/"));
  for (const line of annotations) console.log(line);
  return { inspected, findings, warnings: report.warnings.length };
}

runCheck(import.meta.url, {
  scan: () => lintBuild(fileURLToPath(new URL("..", import.meta.url))),
  empty: `${BUILD_DIR} holds no files; run \`bun run build:firefox\` first.`,
  failed: (count) =>
    `${count} addons-linter finding(s) in the Firefox build (errors, or warnings not in ACCEPTED_WARNINGS).`,
  passed: ({ inspected, warnings }) =>
    `Firefox lint passed: 0 errors, ${warnings} accepted warning(s) annotated above, ${inspected} files scanned.`,
});
