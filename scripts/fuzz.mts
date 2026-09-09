#!/usr/bin/env bun
// The seeded, bounded fuzz run behind `bun run fuzz`: every `*-fuzz.test.ts`
// suite under apps/extension/tests, run through vitest with fast-check told
// the seed and the per-property run count (tests/helpers/fuzz.ts reads them),
// and a failure report per red suite in the shape repo-platform's fuzz-issue
// action files as a tracking issue (docs/fuzzer.md there, contract v1).
//
//   SEED=<int>                the fast-check seed; random when unset
//   ITERATIONS=<int>          runs per property (default 1000)
//   FUZZ_TIMEOUT_MINUTES=<n>  wall clock for the whole run (default 45); a
//                             suite still running at the deadline is killed
//                             and reported as hung, so a hang fails the run
//                             instead of hitting the CI job's cancel timeout
//
// Arguments name the suites to run, as paths from the repo root (default:
// all of them). The chrome vitest variant only: the fuzzed modules (protocol,
// text/SSML, provider response parsing) read no browser flag, so the firefox
// variant would replay the same code with a second seed's worth of time.
//
// Outcomes: exit 0 and no .fuzz-failures/ directory when every suite passes;
// exit 1 with .fuzz-failures/<suite>/report.md per failing suite (the stale
// directory from a previous run is removed first); exit 2 on a bad option.
// Each report's fenced block holds the exact replay command, for example
//   SEED=123 ITERATIONS=1000 bun run fuzz -- apps/extension/tests/lib/unicode-text-fuzz.test.ts
// Pin a found counterexample as an explicit `it(...)` case in its suite so it
// replays on every regular test run, not only on nights with its seed.

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { invokedDirectly } from "./lib/report.mts";
import { walk } from "./lib/walk.mts";

export const DEFAULT_ITERATIONS = 1000;
export const DEFAULT_TIMEOUT_MINUTES = 45;
export const FAILURES_DIR = ".fuzz-failures";
const EXTENSION_DIR = "apps/extension";
const SUITE_SUFFIX = "-fuzz.test.ts";
/** The fuzz-issue action's rule for a failure directory name. */
const SUITE_NAME = /^[A-Za-z0-9._-]+$/;
/** How much of the failing properties' text one report carries; the rest
 *  stays in the run log. */
const MESSAGE_LINES = 60;
const MESSAGE_CHARS = 8000;
/** Grace between SIGTERM and SIGKILL for a suite that overran the deadline. */
const KILL_GRACE_MS = 5000;

export class UsageError extends Error {}

export interface FuzzOptions {
  seed: number;
  iterations: number;
  timeoutMinutes: number;
  /** Suite files as given on the command line; empty means every suite. */
  files: string[];
}

/** One `*-fuzz.test.ts` suite. */
export interface Suite {
  /** The failure directory name: the file's basename without `.test.ts`. */
  name: string;
  /** Path from the repository root, as the replay command names it. */
  path: string;
  /** Path from apps/extension, as vitest wants its filter. */
  vitestPath: string;
}

export interface Failure {
  /** The property's full name (describe titles plus the it title). */
  name: string;
  message: string;
}

export type SuiteOutcome =
  | { status: "passed" }
  | { status: "failed"; failures: Failure[] }
  /** vitest exited red without naming a failing test; `detail` says what it left behind. */
  | { status: "crashed"; exitCode: number | null; detail: string }
  /** Killed at the deadline, `budgetMs` after it started. */
  | { status: "timed-out"; budgetMs: number }
  /** Never started: an earlier suite spent the wall clock. */
  | { status: "not-run" };

/** Runs one suite with the given environment, within `budgetMs`. */
export type SuiteRunner = (
  suite: Suite,
  env: Record<string, string>,
  budgetMs: number,
) => Promise<SuiteOutcome>;

/** Options from the environment and the command line. Blank values count as
 *  unset, so `SEED=""` from a workflow input picks a random seed. */
export function readOptions(env: Record<string, string | undefined>, args: string[]): FuzzOptions {
  return {
    seed: integerOption(env, "SEED") ?? Math.floor(Math.random() * 2 ** 31),
    iterations: positiveOption(env, "ITERATIONS") ?? DEFAULT_ITERATIONS,
    timeoutMinutes: positiveOption(env, "FUZZ_TIMEOUT_MINUTES") ?? DEFAULT_TIMEOUT_MINUTES,
    files: args,
  };
}

function integerOption(env: Record<string, string | undefined>, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new UsageError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

function positiveOption(env: Record<string, string | undefined>, name: string): number | undefined {
  const value = integerOption(env, name);
  if (value !== undefined && value < 1) {
    throw new UsageError(`${name} must be at least 1, got ${value}`);
  }
  return value;
}

/** Every fuzz suite under apps/extension/tests, in path order. */
export function allSuites(root: string): Suite[] {
  const files = [...walk(join(root, EXTENSION_DIR, "tests"), { extensions: [SUITE_SUFFIX] })];
  return files.map((file) => suiteAt(root, file));
}

/** The suites the command line names, or all of them when it names none. */
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

/** The vitest command line for one suite: the JSON reporter tells the runner
 *  which properties failed, the default reporter streams to the log, and the
 *  per-test timeout is off because a property's run count is now the budget
 *  (the wall clock in `runFuzz` bounds a real hang). */
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

/** The environment the suites read their parameters from. */
export function suiteEnv(options: FuzzOptions): Record<string, string> {
  return { FUZZ_SEED: String(options.seed), FUZZ_ITERATIONS: String(options.iterations) };
}

/** The command that replays one suite with the run's seed and budget, from
 *  the repository root; the wall clock is named only when it was changed. */
export function replayCommand(options: FuzzOptions, suite: Suite): string {
  const timeout =
    options.timeoutMinutes === DEFAULT_TIMEOUT_MINUTES
      ? ""
      : `FUZZ_TIMEOUT_MINUTES=${options.timeoutMinutes} `;
  return `${timeout}SEED=${options.seed} ITERATIONS=${options.iterations} bun run fuzz -- ${suite.path}`;
}

/** The failures in a vitest JSON report (`--reporter=json`): each failed test
 *  with its messages, or, for a file that failed with no failed test (it did
 *  not collect: a syntax or import error), the file with its own message.
 *  Stack frames are dropped: the property's message names the seed, the path,
 *  and the counterexample, which is what a reader needs. */
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

/** Whether the report counts at least one test: vitest's passWithNoTests
 *  exits 0 for a filter that matched nothing, which is not a green suite. */
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

/** The describe titles and the test title, joined the way vitest prints a
 *  failure (`a > b > c`); the JSON's own fullName runs them together. */
function testName(test: Record<string, unknown>): string {
  const ancestors = Array.isArray(test.ancestorTitles) ? test.ancestorTitles : [];
  const parts = [...ancestors, test.title].filter((part) => typeof part === "string");
  return parts.length > 0 ? parts.join(" > ") : String(test.fullName ?? "(unnamed)");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The report.md for one red suite: title line, the replay command in a
 *  fenced block, the seed, then what failed, bounded so the tracking issue
 *  carries the essentials near the top. */
export function renderReport(options: FuzzOptions, suite: Suite, outcome: SuiteOutcome): string {
  const lines = [
    `# Fuzz failure in ${suite.name}`,
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
    "Pin the regression: add the counterexample as an explicit `it(...)` case in the suite, so it replays on every test run and not only under this seed.",
    "",
  ];
  if (outcome.status === "timed-out") {
    const minutes = (outcome.budgetMs / 60_000).toFixed(1);
    lines.push(
      "## Hung",
      "",
      `The suite was still running ${minutes} minutes after it started, when the run's ${options.timeoutMinutes}-minute wall clock ran out, and was killed. No counterexample: the run log shows how far it got.`,
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
    lines.push("## Failing properties", "", ...boundedFailureText(outcome.failures));
  }
  return `${lines.join("\n")}\n`;
}

/** Every failing property as a heading plus its message in a fenced block,
 *  cut to MESSAGE_LINES lines and MESSAGE_CHARS characters in total with a
 *  closing line saying so. */
function boundedFailureText(failures: Failure[]): string[] {
  const text: string[] = [];
  for (const failure of failures) {
    text.push(`### ${failure.name}`, "", "```", ...failure.message.split("\n"), "```", "");
  }
  let kept = 0;
  let chars = 0;
  while (kept < text.length && kept < MESSAGE_LINES) {
    const line = text[kept] ?? "";
    if (chars + line.length + 1 > MESSAGE_CHARS) break;
    chars += line.length + 1;
    kept++;
  }
  if (kept === text.length) return text;
  const out = text.slice(0, kept);
  // A cut inside a fenced block would swallow the rest of the report.
  if (out.filter((line) => line === "```").length % 2 === 1) out.push("```");
  out.push(`... ${text.length - kept} more line(s) in the run log.`);
  return out;
}

/** Runs the suites in order against one shared deadline, writes a report for
 *  each red one, and returns the process exit code. */
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

/** The real runner: one vitest process per suite, its output streamed, its
 *  JSON result read from a scratch file that is removed on every path. */
export function runWithVitest(root: string): SuiteRunner {
  return async (suite, env, budgetMs) => {
    const scratch = mkdtempSync(join(tmpdir(), "cloud-speech-fuzz-"));
    const resultsFile = join(scratch, "results.json");
    try {
      // Its own process group, so the deadline (or a Ctrl-C on the runner)
      // reaches vitest's worker forks too and no orphan keeps fuzzing.
      const child = spawn("bun", vitestArgs(suite, resultsFile), {
        cwd: root,
        env: { ...process.env, ...env },
        stdio: "inherit",
        detached: true,
      });
      const exit = await waitFor(child, budgetMs);
      if (exit.timedOut) return { status: "timed-out", budgetMs };
      if (!existsSync(resultsFile)) {
        return { status: "crashed", exitCode: exit.code, detail: "without writing a result file" };
      }
      const report: unknown = JSON.parse(readFileSync(resultsFile, "utf8"));
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

/** Resolves when the child exits, or kills its process group (SIGTERM, then
 *  SIGKILL after a grace period) once `budgetMs` has elapsed. A SIGINT or
 *  SIGTERM to the runner is passed on to the group first, then re-raised. */
function waitFor(
  child: ChildProcess,
  budgetMs: number,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((settle, reject) => {
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const deadline = setTimeout(() => {
      timedOut = true;
      killGroup(child, "SIGTERM");
      killTimer = setTimeout(() => killGroup(child, "SIGKILL"), KILL_GRACE_MS);
    }, budgetMs);
    const forward = (signal: NodeJS.Signals) => {
      killGroup(child, signal);
      process.exit(128 + (signal === "SIGINT" ? 2 : 15));
    };
    process.once("SIGINT", forward);
    process.once("SIGTERM", forward);
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
      if (timedOut) killGroup(child, "SIGKILL");
      settle({ code, timedOut });
    });
  });
}

/** Signals the child's whole process group (it was spawned detached, so it
 *  leads one); falls back to the child alone if the group is already gone. */
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
    throw error;
  }
}

if (invokedDirectly(import.meta.url)) process.exit(await main());
