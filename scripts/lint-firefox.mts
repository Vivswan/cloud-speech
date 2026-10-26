#!/usr/bin/env bun
// Mozilla's addons-linter, the validator addons.mozilla.org runs on every upload, on the built Firefox
// directory: WXT zips it unchanged, so the verdict is the same, and the directory has one fixed path while
// the zip carries the version in its name.
//   error                              -> fails the check
//   warning outside ACCEPTED_WARNINGS  -> fails the check
//   accepted warning                   -> GitHub annotation only

import { statSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AnnotationProperties, error, notice, warning } from "@actions/core";
import { relative } from "pathe";
import { runCheck } from "./lib/report.mts";
import { walk } from "./lib/walk.mts";

/** WXT's Firefox output, relative to the repository root. */
const BUILD_DIR = "apps/extension/.output/firefox-mv3";

/** Library warnings the build is known to produce, each with its source named; one in our own code is fixed instead. */
export const ACCEPTED_WARNINGS: readonly { code: string; file: RegExp; source: string }[] = [
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

/** addons-linter ships no types: the surface used here, as its README documents it. */
interface AddonsLinter {
  createInstance(options: {
    config: {
      // biome-ignore lint/style/useNamingConvention: yargs names the positionals `_`, here the directory to lint
      _: string[];

      /** The linter's own logging; "fatal" keeps it out of the check's output. */
      logLevel: "debug" | "info" | "warn" | "error" | "fatal";

      /** Stack traces when the linter itself throws. */
      stack: boolean;

      /** Prettified JSON, for the "json" output. */
      pretty: boolean;

      /** Off here: which warnings fail is this check's decision (ACCEPTED_WARNINGS). */
      warningsAsErrors: boolean;

      /** Only the add-on's metadata as JSON, no scan. */
      metadata: boolean;

      /** What the linter prints itself; "none", and the report is read off the instance instead. */
      output: "none" | "text" | "json";

      /** No color in what the linter prints. */
      boring: boolean;

      /** Drops the messages that apply only to hosting on addons.mozilla.org. */
      selfHosted: boolean;

      /** Every file, here: the build directory is the whole scan. */
      shouldScanFile: (fileName: string) => boolean;
    };
    runAsBinary: boolean;
  }): { run(): Promise<unknown>; readonly output: LinterReport };
}

const ANNOTATE: Record<
  LinterMessage["_type"],
  (message: string, properties: AnnotationProperties) => void
> = { error, warning, notice };

/** The message as an Actions annotation, so the run shows it without failing. A position without a file
 *  points nowhere, so it travels only with one. */
export function annotate(message: LinterMessage, dir: string): void {
  const properties: AnnotationProperties = { title: message.code };
  if (message.file !== undefined) {
    properties.file = `${dir}/${message.file}`;
    properties.startLine = message.line;
    properties.startColumn = message.column;
  }
  ANNOTATE[message._type](message.message, properties);
}

/** By code and file, never by count (React DOM trips the same rule twice), and per file because a bundle mixes our code with its libraries; `source` is for the reader only. */
const isAccepted = (warning: LinterMessage) =>
  ACCEPTED_WARNINGS.some(
    (entry) => entry.code === warning.code && entry.file.test(warning.file ?? ""),
  );

export function findings(report: LinterReport, dir: string): string[] {
  const where = (message: LinterMessage) =>
    message.file === undefined
      ? "(no file)"
      : `${dir}/${message.file}${message.line === undefined ? "" : `:${message.line}`}`;
  const describe = (message: LinterMessage) =>
    `${where(message)} ${message.code}: ${message.message}`;
  return [
    ...report.errors.map(describe),
    ...report.warnings
      .filter((warning) => !isAccepted(warning))
      .map(
        (warning) =>
          `${describe(warning)} (not an accepted warning: fix the code, or if a library emits it, add it to ACCEPTED_WARNINGS in scripts/lint-firefox.mts with its source named)`,
      ),
  ];
}

/** The linter's own report on one extension directory. addons-linter is a CommonJS bundle whose named
 *  exports an ESM import cannot see, hence the require. */
export async function lint(dir: string): Promise<LinterReport> {
  const { createInstance } = createRequire(import.meta.url)("addons-linter") as AddonsLinter;
  const linter = createInstance({
    config: {
      // biome-ignore lint/style/useNamingConvention: yargs names the positionals `_`
      _: [dir],
      logLevel: "fatal",
      stack: false,
      pretty: false,
      warningsAsErrors: false,
      metadata: false,
      output: "none",
      boring: true,
      selfHosted: false,
      shouldScanFile: () => true,
    },
    runAsBinary: false,
  });
  await linter.run();
  return linter.output;
}

/** `inspected` counts the build's files, so a missing or empty build fails rather than passes. Every
 *  message is annotated, findings included, so they show in the run too. */
async function lintBuild(root: string): Promise<{
  inspected: number;
  findings: string[];
  warnings: number;
}> {
  const dir = resolve(root, BUILD_DIR);
  if (statSync(dir, { throwIfNoEntry: false }) === undefined) {
    return { inspected: 0, findings: [], warnings: 0 };
  }
  const inspected = walk(dir, { extensions: [""] }).length;
  if (inspected === 0) return { inspected, findings: [], warnings: 0 };

  const report = await lint(dir);
  // pathe's relative is slash-separated on every host, as reports and annotations are written.
  const reported = relative(root, dir);
  for (const message of [...report.errors, ...report.warnings, ...report.notices]) {
    annotate(message, reported);
  }
  return { inspected, findings: findings(report, reported), warnings: report.warnings.length };
}

if (import.meta.main) {
  await runCheck({
    scan: () => lintBuild(fileURLToPath(new URL("..", import.meta.url))),
    empty: `${BUILD_DIR} is missing or holds no files; run \`bun run build:firefox\` first.`,
    failed: (count) =>
      `${count} addons-linter finding(s) in the Firefox build (errors, or warnings not in ACCEPTED_WARNINGS).`,
    passed: ({ inspected, warnings }) =>
      `Firefox lint passed: 0 errors, ${warnings} accepted warning(s) annotated above, ${inspected} files scanned.`,
  });
}
