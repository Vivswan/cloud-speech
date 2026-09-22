#!/usr/bin/env bun
// Mozilla's addons-linter, the validator addons.mozilla.org runs on every upload, on the built Firefox
// directory: WXT zips it unchanged, so the verdict is the same, and the directory has one fixed path while
// the zip carries the version in its name.
//   error                              -> fails the check
//   warning outside ACCEPTED_WARNINGS  -> fails the check
//   accepted warning                   -> GitHub annotation only

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "./lib/report.mts";
import { walk } from "./lib/walk.mts";

const BUILD_DIR = "apps/extension/.output/firefox-mv3";

/** Warnings the build is known to produce: a new library pattern joins with its source named, a warning
 *  in our own code is fixed instead.
 *    counts  -> not compared; React DOM trips the same rule twice
 *    source  -> explanation only: acceptance is per file, and a bundle mixes our code with its libraries */
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
      /** The command line's positional argument: the directory to lint. */
      // biome-ignore lint/style/useNamingConvention: yargs names the positionals `_`
      _: string[];
      logLevel: "debug" | "info" | "warn" | "error" | "fatal";
      stack: boolean;
      pretty: boolean;
      warningsAsErrors: boolean;
      metadata: boolean;
      output: "none" | "text" | "json";
      boring: boolean;
      selfHosted: boolean;
      shouldScanFile: (fileName: string) => boolean;
    };
    runAsBinary: boolean;
  }): { run(): Promise<unknown>; readonly output: LinterReport };
}

// GitHub's workflow-command escaping (actions/core): the message keeps commas and colons, the
// properties cannot.
const escapeData = (text: string) =>
  text.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
const escapeProperty = (text: string) =>
  escapeData(text).replaceAll(":", "%3A").replaceAll(",", "%2C");

/** A workflow-command line, so the Actions run shows the message without failing. */
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

/** Findings fail the check; annotations cover every message, findings included, so they show in the
 *  run too. */
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

/** `inspected` counts the build's files, so a missing or empty build fails rather than passes. */
export async function lintBuild(root: string): Promise<{
  inspected: number;
  findings: string[];
  warnings: number;
}> {
  const dir = resolve(root, BUILD_DIR);
  if (!existsSync(dir)) {
    throw new Error(`${BUILD_DIR} is missing; run \`bun run build:firefox\` first.`);
  }
  const inspected = walk(dir, { extensions: [""] }).length;
  if (inspected === 0) return { inspected, findings: [], warnings: 0 };

  const report = await lint(dir);
  const { findings, annotations } = classify(report, relative(root, dir).replaceAll("\\", "/"));
  for (const line of annotations) console.log(line);
  return { inspected, findings, warnings: report.warnings.length };
}

await runCheck(import.meta.url, {
  scan: () => lintBuild(fileURLToPath(new URL("..", import.meta.url))),
  empty: `${BUILD_DIR} holds no files; run \`bun run build:firefox\` first.`,
  failed: (count) =>
    `${count} addons-linter finding(s) in the Firefox build (errors, or warnings not in ACCEPTED_WARNINGS).`,
  passed: ({ inspected, warnings }) =>
    `Firefox lint passed: 0 errors, ${warnings} accepted warning(s) annotated above, ${inspected} files scanned.`,
});
