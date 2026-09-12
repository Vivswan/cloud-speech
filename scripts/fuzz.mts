#!/usr/bin/env bun
// The seeded fuzz run behind `bun run fuzz`: every `*-fuzz.test.ts` suite under apps/extension/tests
// through vitest, with a failure report per red suite in the shape the fleet's fuzz-issue action files
// as a tracking issue (its docs/fuzzer.md, contract v1). vitest's browser target is left at its chrome
// default: the fuzzed modules read no browser flag, so the firefox variant would replay the same code.
//
//   SEED=<int>                fast-check seed; random when unset
//   ITERATIONS=<int>          runs per property (default 1000)
//   FUZZ_TIMEOUT_MINUTES=<n>  wall clock for the whole run (default 45); a suite still running then is
//                             killed and reported as hung, so a hang fails the run instead of hitting
//                             the CI job's cancel timeout
//   <arguments>               suite paths from the repo root (default: all of them)
//
//   exit 0  every suite passed; no .fuzz-failures/ directory
//   exit 1  .fuzz-failures/<suite>/report.md per red suite (a previous run's directory is removed first)
//   exit 2  bad option

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { integerEnv, positiveEnv, UsageError } from "./lib/env.mts";
import { invokedDirectly } from "./lib/report.mts";
import { walk } from "./lib/walk.mts";

export const DEFAULT_ITERATIONS = 1000;
export const DEFAULT_TIMEOUT_MINUTES = 45;
export const FAILURES_DIR = ".fuzz-failures";
const EXTENSION_DIR = "apps/extension";
const SUITE_SUFFIX = "-fuzz.test.ts";
/** The fuzz-issue action's rule for a failure directory name. */
const SUITE_NAME = /^[A-Za-z0-9._-]+$/;
/** What the fuzz-issue action keeps of a report (the fleet's actions/fuzz-issue/fuzz-issue.ts); the
 *  report is cut to fit it.
 *    title line                  -> dropped
 *    the rest                    -> first 60 lines
 *    `## <title>\n\n<body>\n`    -> at most 8000 characters */
const BODY_LINES = 60;
const BLOCK_CHARS = 8000;

function fitsBlock(title: string, body: string): boolean {
  const block = `## ${title}\n\n${body}\n`;
  return body.split("\n").length <= BODY_LINES && block.length <= BLOCK_CHARS;
}
const KILL_GRACE_MS = 5000;

/** The runner was told to stop (Ctrl-C, a cancelled job) while a suite ran. */
export class Interrupted extends Error {
  constructor(readonly signal: NodeJS.Signals) {
    super(`interrupted by ${signal}`);
  }
}

export interface FuzzOptions {
  seed: number;
  iterations: number;
  timeoutMinutes: number;
  /** Suite files as given on the command line; empty means every suite. */
  files: string[];
}

export interface Suite {
  /** The failure directory name: the file's basename without `.test.ts`. */
  name: string;
  /** Path from the repository root, as the replay command names it. */
  path: string;
  /** Path from apps/extension, as vitest wants its filter. */
  vitestPath: string;
}

export interface Failure {
  /** The property's full name (describe titles plus the it title), or the file name for a file marked
   *  failed with no failed test. */
  name: string;
  message: string;
}

export type SuiteOutcome =
  | { status: "passed" }
  | { status: "failed"; failures: Failure[] }
  /** No failing property to name, even on exit 0 (a result file that counts no test); `detail` says what
   *  vitest left behind. */
  | { status: "crashed"; exitCode: number | null; detail: string }
  /** Killed at the deadline, `budgetMs` after it started. */
  | { status: "timed-out"; budgetMs: number }
  /** Never started: an earlier suite spent the wall clock. */
  | { status: "not-run" };

export type SuiteRunner = (
  suite: Suite,
  env: Record<string, string>,
  budgetMs: number,
) => Promise<SuiteOutcome>;

export function readOptions(env: Record<string, string | undefined>, args: string[]): FuzzOptions {
  return {
    seed: integerEnv(env, "SEED") ?? Math.floor(Math.random() * 2 ** 31),
    iterations: positiveEnv(env, "ITERATIONS") ?? DEFAULT_ITERATIONS,
    timeoutMinutes: positiveEnv(env, "FUZZ_TIMEOUT_MINUTES") ?? DEFAULT_TIMEOUT_MINUTES,
    files: args,
  };
}

export function allSuites(root: string): Suite[] {
  const files = [...walk(join(root, EXTENSION_DIR, "tests"), { extensions: [SUITE_SUFFIX] })];
  return files.map((file) => suiteAt(root, file));
}

export function selectSuites(root: string, files: string[]): Suite[] {
  if (files.length === 0) return allSuites(root);
  return files.map((file) => {
    const absolute = isAbsolute(file) ? file : resolve(root, file);
    if (!absolute.endsWith(SUITE_SUFFIX)) {
      throw new UsageError(`${file} is not a fuzz suite (expected a *${SUITE_SUFFIX} file)`);
    }
    if (!existsSync(absolute)) throw new UsageError(`${file} does not exist`);
    return suiteAt(root, absolute);
  });
}

function suiteAt(root: string, absolute: string): Suite {
  const name = basename(absolute, ".test.ts");
  if (!SUITE_NAME.test(name)) {
    throw new UsageError(
      `suite name ${JSON.stringify(name)} is not a valid failure directory name`,
    );
  }
  return {
    name,
    path: toPosix(relative(root, absolute)),
    vitestPath: toPosix(relative(join(root, EXTENSION_DIR), absolute)),
  };
}

const toPosix = (path: string) => path.replaceAll("\\", "/");

/** Two reporters: JSON tells the runner which properties failed, default streams to the log.
 *  --testTimeout=0 because a property's run count is its budget; the wall clock in `runFuzz` bounds a real hang. */
export function vitestArgs(suite: Suite, resultsFile: string): string[] {
  return [
    "run",
    "--cwd",
    EXTENSION_DIR,
    "vitest",
    "run",
    "--reporter=default",
    "--reporter=json",
    `--outputFile.json=${resultsFile}`,
    "--testTimeout=0",
    suite.vitestPath,
  ];
}

export function suiteEnv(options: FuzzOptions): Record<string, string> {
  return { FUZZ_SEED: String(options.seed), FUZZ_ITERATIONS: String(options.iterations) };
}

export function replayCommand(options: FuzzOptions, suite: Suite): string {
  const timeout =
    options.timeoutMinutes === DEFAULT_TIMEOUT_MINUTES
      ? ""
      : `FUZZ_TIMEOUT_MINUTES=${options.timeoutMinutes} `;
  return `${timeout}SEED=${options.seed} ITERATIONS=${options.iterations} bun run fuzz -- ${suite.path}`;
}

/** A file marked failed with no failed test (a syntax or import error, or a failing hook) is reported
 *  under its own message. Stack frames are dropped: the property's message already names the seed, the
 *  path, and the counterexample. */
export function collectFailures(report: unknown): Failure[] {
  const failures: Failure[] = [];
  if (!isRecord(report) || !Array.isArray(report.testResults)) return failures;
  for (const file of report.testResults) {
    if (!isRecord(file) || !Array.isArray(file.assertionResults)) continue;
    let failedTests = 0;
    for (const test of file.assertionResults) {
      if (!isRecord(test) || test.status !== "failed") continue;
      failedTests++;
      const messages = Array.isArray(test.failureMessages) ? test.failureMessages : [];
      failures.push({ name: testName(test), message: withoutFrames(messages) });
    }
    if (failedTests === 0 && file.status === "failed") {
      failures.push({
        name: `${basename(String(file.name ?? "(unknown file)"))} (did not collect)`,
        message: withoutFrames([file.message]),
      });
    }
  }
  return failures;
}

/** vitest's passWithNoTests exits 0 for a filter that matched nothing, which is not a green suite. */
export function ranTests(report: unknown): boolean {
  return isRecord(report) && typeof report.numTotalTests === "number" && report.numTotalTests > 0;
}

function withoutFrames(messages: unknown[]): string {
  return messages
    .filter((entry): entry is string => typeof entry === "string")
    .join("\n")
    .split("\n")
    .filter((line) => !/^\s+at\s/.test(line))
    .join("\n")
    .trim();
}

/** Joined the way vitest prints a failure (`a > b > c`); the JSON's own fullName runs the titles together. */
function testName(test: Record<string, unknown>): string {
  const ancestors = Array.isArray(test.ancestorTitles) ? test.ancestorTitles : [];
  const parts = [...ancestors, test.title].filter((part) => typeof part === "string");
  return parts.length > 0 ? parts.join(" > ") : String(test.fullName ?? "(unnamed)");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The essentials come first: the body after the title is cut to what the tracking issue keeps. */
export function renderReport(options: FuzzOptions, suite: Suite, outcome: SuiteOutcome): string {
  const title = `Fuzz failure in ${suite.name}`;
  const lines = [
    `# ${title}`,
    "",
    `Suite: \`${suite.path}\``,
    "",
    "Replay from the repository root:",
    "",
    "```sh",
    replayCommand(options, suite),
    "```",
    "",
    `Seed: ${options.seed}`,
    `Iterations per property: ${options.iterations}`,
    "",
  ];
  if (outcome.status === "timed-out") {
    const minutes = (outcome.budgetMs / 60_000).toFixed(1);
    lines.push(
      "## Hung",
      "",
      `The suite was still running ${minutes} minutes after it started, when the run's ${options.timeoutMinutes}-minute wall clock ran out, and was killed. ` +
        "No counterexample: vitest prints a file's results only when it finishes, so the run log names the suite and nothing more; " +
        "replay the suite alone under this seed to find the property.",
    );
  } else if (outcome.status === "not-run") {
    lines.push(
      "## Not run",
      "",
      `An earlier suite spent the run's ${options.timeoutMinutes}-minute wall clock before this one started. Replay it on its own, or raise FUZZ_TIMEOUT_MINUTES.`,
    );
  } else if (outcome.status === "crashed") {
    lines.push(
      "## Crashed",
      "",
      `vitest exited with ${outcome.exitCode ?? "a signal"} ${outcome.detail}. The run log has the error.`,
    );
  } else if (outcome.status === "failed") {
    lines.push(
      "Pin the regression: add the counterexample as an explicit `it(...)` case in the suite, so it replays on every test run and not only under this seed.",
      "",
      "## Failing properties",
      "",
    );
    // The action reads the body after the title line, so the failures get the room the preamble leaves.
    const preamble = lines.slice(1);
    const fits = (tail: string[]) => fitsBlock(title, [...preamble, ...tail].join("\n").trim());
    lines.push(...boundedFailureText(outcome.failures, fits));
  }
  return `${lines.join("\n")}\n`;
}

function boundedFailureText(failures: Failure[], fits: (text: string[]) => boolean): string[] {
  const text: string[] = [];
  for (const failure of failures) {
    text.push(`### ${failure.name}`, "", "```", ...failure.message.split("\n"), "```", "");
  }
  if (fits(text)) return text;
  const cut = (kept: number) => {
    const out = text.slice(0, kept);
    if (out.filter((line) => line === "```").length % 2 === 1) out.push("```");
    out.push(`... ${text.length - kept} more line(s) in the run log.`);
    return out;
  };
  // Fit is not monotonic in the prefix length (one more line can replace the added fence with the real
  // one, or drop a digit from the marker), so every length is tried, longest first.
  for (let kept = Math.min(text.length - 1, BODY_LINES); kept > 0; kept--) {
    const candidate = cut(kept);
    if (fits(candidate)) return candidate;
  }
  return cut(0);
}

export async function runFuzz(
  options: FuzzOptions,
  deps: {
    root: string;
    runner: SuiteRunner;
    log: (line: string) => void;
    /** The clock the deadline is read from; tests hand in their own. */
    now?: () => number;
  },
): Promise<number> {
  const { root, runner, log, now = Date.now } = deps;
  const suites = selectSuites(root, options.files);
  const failuresDir = join(root, FAILURES_DIR);
  rmSync(failuresDir, { recursive: true, force: true });
  const deadline = now() + options.timeoutMinutes * 60_000;
  const env = suiteEnv(options);
  log(
    `fuzz: seed ${options.seed}, ${options.iterations} iterations per property, ${options.timeoutMinutes} min wall clock, ${suites.length} suite(s)`,
  );

  const red: string[] = [];
  for (const suite of suites) {
    const budgetMs = deadline - now();
    let outcome: SuiteOutcome;
    if (budgetMs <= 0) {
      outcome = { status: "not-run" };
    } else {
      log(`fuzz: ${suite.name} (${suite.path})`);
      outcome = await runner(suite, env, budgetMs);
    }
    if (outcome.status === "passed") {
      log(`fuzz: ${suite.name} passed`);
      continue;
    }
    red.push(suite.name);
    const dir = join(failuresDir, suite.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "report.md"), renderReport(options, suite, outcome));
    log(`fuzz: ${suite.name} ${outcome.status}; report at ${FAILURES_DIR}/${suite.name}/report.md`);
  }
  if (red.length === 0) {
    log(`fuzz: all ${suites.length} suite(s) passed with seed ${options.seed}`);
    return 0;
  }
  log(`fuzz: ${red.length} of ${suites.length} suite(s) failed with seed ${options.seed}`);
  return 1;
}

export interface VitestRunnerOptions {
  /** Where vitest's output goes; tests of the runner itself drop it. */
  stdio?: "inherit" | "ignore";
  tmp?: string;
}

export function runWithVitest(root: string, options: VitestRunnerOptions = {}): SuiteRunner {
  const { stdio = "inherit", tmp = tmpdir() } = options;
  return async (suite, env, budgetMs) => {
    const scratch = mkdtempSync(join(tmp, "cloud-speech-fuzz-"));
    const resultsFile = join(scratch, "results.json");
    try {
      // Its own process group, so the deadline (or a Ctrl-C on the runner)
      // reaches vitest's worker forks too and no orphan keeps fuzzing.
      const child = spawn("bun", vitestArgs(suite, resultsFile), {
        cwd: root,
        env: { ...process.env, ...env },
        stdio,
        detached: true,
      });
      const exit = await waitFor(child, budgetMs);
      // A signal during the deadline's grace period still ends the run.
      if (exit.interrupted) throw new Interrupted(exit.interrupted);
      if (exit.timedOut) return { status: "timed-out", budgetMs };
      if (!existsSync(resultsFile)) {
        return { status: "crashed", exitCode: exit.code, detail: "without writing a result file" };
      }
      const report = parseJson(readFileSync(resultsFile, "utf8"));
      if (report === undefined) {
        return {
          status: "crashed",
          exitCode: exit.code,
          detail: "leaving a result file that is not JSON",
        };
      }
      const failures = collectFailures(report);
      if (failures.length > 0) return { status: "failed", failures };
      if (exit.code === 0 && ranTests(report)) return { status: "passed" };
      const detail = ranTests(report)
        ? "with a result file that names no failure"
        : "with a result file that counts no test";
      return { status: "crashed", exitCode: exit.code, detail };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };
}

/** undefined instead of a throw: a result file cut short by a crash is not JSON. */
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

interface Exit {
  code: number | null;
  /** The deadline killed the suite. */
  timedOut: boolean;
  /** The runner itself was signalled and stopped the suite. */
  interrupted?: NodeJS.Signals;
}

function waitFor(child: ChildProcess, budgetMs: number): Promise<Exit> {
  return new Promise((settle, reject) => {
    let timedOut = false;
    let interrupted: NodeJS.Signals | undefined;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = (signal: NodeJS.Signals) => {
      killGroup(child, signal);
      killTimer ??= setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    };
    const deadline = setTimeout(() => {
      timedOut = true;
      stop("SIGTERM");
    }, budgetMs);
    // Kept attached until the child is gone: a second Ctrl-C must not take
    // the default path and end the runner before its cleanup.
    const forward = (signal: NodeJS.Signals) => {
      interrupted ??= signal;
      stop(signal);
    };
    process.on("SIGINT", forward);
    process.on("SIGTERM", forward);
    const done = () => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      process.off("SIGINT", forward);
      process.off("SIGTERM", forward);
    };
    child.once("error", (error) => {
      done();
      reject(error);
    });
    child.once("exit", (code) => {
      done();
      // The leader is gone; a worker fork that outlived it goes with the group.
      if (timedOut || interrupted) killGroup(child, "SIGKILL");
      settle({ code, timedOut, interrupted });
    });
  });
}

/** The negative pid signals the whole process group the detached child leads. */
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

async function main(): Promise<number> {
  const root = fileURLToPath(new URL("..", import.meta.url));
  let options: FuzzOptions;
  try {
    options = readOptions(process.env, process.argv.slice(2));
    return await runFuzz(options, { root, runner: runWithVitest(root), log: console.log });
  } catch (error) {
    if (error instanceof UsageError) {
      console.error(`x ${error.message}`);
      return 2;
    }
    if (error instanceof Interrupted) {
      console.error(`fuzz: ${error.message}`);
      return 128 + (error.signal === "SIGINT" ? 2 : 15);
    }
    throw error;
  }
}

if (invokedDirectly(import.meta.url)) process.exit(await main());
