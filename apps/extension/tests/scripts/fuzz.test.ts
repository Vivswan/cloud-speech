import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allSuites,
  collectFailures,
  DEFAULT_ITERATIONS,
  DEFAULT_TIMEOUT_MINUTES,
  FAILURES_DIR,
  type FuzzOptions,
  Interrupted,
  ranTests,
  readOptions,
  renderReport,
  replayCommand,
  runFuzz,
  runWithVitest,
  type Suite,
  type SuiteOutcome,
  type SuiteRunner,
  selectSuites,
  suiteEnv,
  vitestArgs,
} from "../../../../scripts/fuzz.mts";
import { UsageError } from "../../../../scripts/lib/env.mts";

const ROOT = resolve(__dirname, "../../../..");

const OPTIONS: FuzzOptions = { seed: 123, iterations: 50, timeoutMinutes: 45, files: [] };

const SUITE: Suite = {
  name: "unicode-text-fuzz",
  path: "apps/extension/tests/lib/unicode-text-fuzz.test.ts",
  vitestPath: "tests/lib/unicode-text-fuzz.test.ts",
};

/** A vitest JSON report with one file whose tests have the given statuses;
 *  `fileError` is the file's own message when it failed to collect. */
function vitestJson(
  tests: { name: string; status: string; messages?: string[] }[],
  fileError = "",
): unknown {
  const green = fileError === "" && tests.every((test) => test.status === "passed");
  return {
    success: green,
    numTotalTests: tests.length,
    testResults: [
      {
        name: join(ROOT, SUITE.path),
        status: green ? "passed" : "failed",
        message: fileError,
        assertionResults: tests.map((test) => ({
          ancestorTitles: test.name.split(" > ").slice(0, -1),
          fullName: test.name.replaceAll(" > ", " "),
          title: test.name.split(" > ").at(-1),
          status: test.status,
          failureMessages: test.messages ?? [],
        })),
      },
    ],
  };
}

describe("readOptions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults to a seed drawn per run, 1000 iterations, and the 45 minute wall clock", () => {
    vi.spyOn(Math, "random").mockReturnValueOnce(0.25).mockReturnValueOnce(0.75);
    const rest = {
      iterations: DEFAULT_ITERATIONS,
      timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
      files: [],
    };
    expect(readOptions({}, [])).toEqual({ seed: 2 ** 29, ...rest });
    expect(readOptions({}, [])).toEqual({ seed: 3 * 2 ** 29, ...rest });
  });

  it("reads SEED, ITERATIONS, FUZZ_TIMEOUT_MINUTES and the suite arguments", () => {
    expect(
      readOptions({ SEED: "42", ITERATIONS: "7", FUZZ_TIMEOUT_MINUTES: "3" }, [SUITE.path]),
    ).toEqual({ seed: 42, iterations: 7, timeoutMinutes: 3, files: [SUITE.path] });
  });

  it("takes a blank SEED (the workflow input's default) as unset and draws one", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const drawn = { seed: 2 ** 30, iterations: 1000, timeoutMinutes: 45, files: [] };
    expect(readOptions({}, [])).toEqual(drawn);
    expect(readOptions({ SEED: "" }, [])).toEqual(drawn);
    expect(readOptions({ SEED: " " }, [])).toEqual(drawn);
  });

  it.each([
    [{ SEED: "abc" }, "SEED must be an integer"],
    [{ ITERATIONS: "0" }, "ITERATIONS must be at least 1"],
    [{ ITERATIONS: "1.5" }, "ITERATIONS must be an integer"],
    [{ FUZZ_TIMEOUT_MINUTES: "-1" }, "FUZZ_TIMEOUT_MINUTES must be at least 1"],
  ])("rejects %j as a usage error", (env, message) => {
    expect(() => readOptions(env, [])).toThrow(UsageError);
    expect(() => readOptions(env, [])).toThrow(message);
  });
});

describe("suite discovery", () => {
  it("finds the three fuzz suites, named after their file", () => {
    expect(allSuites(ROOT)).toEqual([
      {
        name: "protocol-fuzz",
        path: "apps/extension/tests/lib/protocol-fuzz.test.ts",
        vitestPath: "tests/lib/protocol-fuzz.test.ts",
      },
      SUITE,
      {
        name: "response-fuzz",
        path: "apps/extension/tests/providers/response-fuzz.test.ts",
        vitestPath: "tests/providers/response-fuzz.test.ts",
      },
    ]);
    for (const suite of allSuites(ROOT)) expect(suite.name).toMatch(/^[A-Za-z0-9._-]+$/);
  });

  it("selects the suites named on the command line, by root-relative or absolute path", () => {
    expect(selectSuites(ROOT, [SUITE.path])).toEqual([SUITE]);
    expect(selectSuites(ROOT, [join(ROOT, SUITE.path)])).toEqual([SUITE]);
    expect(selectSuites(ROOT, [])).toEqual(allSuites(ROOT));
  });

  it.each([
    ["apps/extension/tests/lib/text.test.ts", "is not a fuzz suite"],
    ["apps/extension/tests/lib/missing-fuzz.test.ts", "does not exist"],
  ])("rejects %s", (file, message) => {
    expect(() => selectSuites(ROOT, [file])).toThrow(UsageError);
    expect(() => selectSuites(ROOT, [file])).toThrow(message);
  });
});

describe("the vitest invocation", () => {
  it("runs one suite in apps/extension with the JSON reporter and no per-test timeout", () => {
    expect(vitestArgs(SUITE, "/tmp/scratch/results.json")).toEqual([
      "run",
      "--cwd",
      "apps/extension",
      "vitest",
      "run",
      "--reporter=default",
      "--reporter=json",
      "--outputFile.json=/tmp/scratch/results.json",
      "--testTimeout=0",
      "tests/lib/unicode-text-fuzz.test.ts",
    ]);
  });

  it("hands the seed and iterations to the suites through the helper's variables", () => {
    expect(suiteEnv(OPTIONS)).toEqual({ FUZZ_SEED: "123", FUZZ_ITERATIONS: "50" });
  });

  it("prints a replay command that runs from the repository root, naming a changed wall clock", () => {
    expect(replayCommand(OPTIONS, SUITE)).toBe(
      "SEED=123 ITERATIONS=50 bun run fuzz -- apps/extension/tests/lib/unicode-text-fuzz.test.ts",
    );
    expect(replayCommand({ ...OPTIONS, timeoutMinutes: 5 }, SUITE)).toBe(
      "FUZZ_TIMEOUT_MINUTES=5 SEED=123 ITERATIONS=50 bun run fuzz -- apps/extension/tests/lib/unicode-text-fuzz.test.ts",
    );
  });
});

describe("collectFailures", () => {
  it("keeps the failed tests with their messages, minus stack frames", () => {
    const report = vitestJson([
      { name: "chunkText > keeps order", status: "passed" },
      {
        name: "chunkText > keeps every character",
        status: "failed",
        messages: [
          'Property failed after 3 tests\n{ seed: 123, path: "2:0", endOnFailure: true }\nCounterexample: ["ab", 8]\nGot error: boom\n    at check (file.ts:1:1)\n    at run (file.ts:2:2)',
        ],
      },
      { name: "escapeXml", status: "failed", messages: ["first", "second"] },
    ]);
    expect(collectFailures(report)).toEqual([
      {
        name: "chunkText > keeps every character",
        message:
          'Property failed after 3 tests\n{ seed: 123, path: "2:0", endOnFailure: true }\nCounterexample: ["ab", 8]\nGot error: boom',
      },
      { name: "escapeXml", message: "first\nsecond" },
    ]);
  });

  it("reports a file that failed without running a test (it did not collect) by its own message", () => {
    const report = vitestJson(
      [],
      'Error: Failed to resolve import "./missing"\n    at TransformPluginContext (x.js:1:1)',
    );
    expect(collectFailures(report)).toEqual([
      {
        name: "unicode-text-fuzz.test.ts (did not collect)",
        message: 'Error: Failed to resolve import "./missing"',
      },
    ]);
  });

  it("finds nothing in a green report or in something that is not a report", () => {
    expect(collectFailures(vitestJson([{ name: "ok", status: "passed" }]))).toEqual([]);
    expect(collectFailures(null)).toEqual([]);
    expect(collectFailures({ testResults: "nope" })).toEqual([]);
  });

  it("ranTests tells a green report apart from one that collected nothing", () => {
    expect(ranTests(vitestJson([{ name: "ok", status: "passed" }]))).toBe(true);
    expect(ranTests(vitestJson([]))).toBe(false);
    expect(ranTests(null)).toBe(false);
  });
});

describe("renderReport", () => {
  const failed: SuiteOutcome = {
    status: "failed",
    failures: [
      {
        name: "chunkText over unicode > keeps every non-whitespace character once",
        message:
          'Property failed after 3 tests\n{ seed: 123, path: "2:0" }\nCounterexample: ["ab", 8]',
      },
    ],
  };

  /** What the fuzz-issue action reads: the body after the title line. */
  const contractBody = (report: string) => report.split("\n").slice(1).join("\n").trim();

  /** A stand-in for the block the fleet's actions/fuzz-issue/fuzz-issue.ts builds, holding a report to the action's
   *  two budgets (60 body lines, 8000 characters). Past a budget the two cut differently, so only an uncut block
   *  here says anything about the action. */
  function actionBlock(report: string): string {
    const title = (report.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim();
    const rest = contractBody(report);
    const restLines = rest.split("\n");
    const head =
      restLines.length <= 60
        ? rest.trimEnd()
        : `${restLines.slice(0, 60).join("\n")}\n... (${restLines.length - 60} more lines)`;
    const block = [`## ${title}`, "", head, ""].join("\n");
    return block.length <= 8000 ? block : `${block.slice(0, 8000 - 16)}\n... (truncated)`;
  }

  it("starts with a heading, carries the replay command in a fenced block, the seed, the pin instruction and the failures", () => {
    const report = renderReport(OPTIONS, SUITE, failed);
    const lines = report.split("\n");
    expect(lines[0]).toBe("# Fuzz failure in unicode-text-fuzz");
    expect(report).toContain(
      "```sh\nSEED=123 ITERATIONS=50 bun run fuzz -- apps/extension/tests/lib/unicode-text-fuzz.test.ts\n```",
    );
    expect(report).toContain("Seed: 123");
    expect(report).toContain("Iterations per property: 50");
    expect(report).toContain("add the counterexample as an explicit `it(...)` case in the suite");
    expect(report).toContain(
      "### chunkText over unicode > keeps every non-whitespace character once",
    );
    expect(report).toContain('Counterexample: ["ab", 8]');
    expect(report.endsWith("\n")).toBe(true);
    // Every fenced block is closed.
    expect(lines.filter((line) => line.startsWith("```")).length % 2).toBe(0);
  });

  /** Failures whose messages are `lines` lines, each the line number, a space and `width` characters. */
  const failing = (count: number, lines: number, width: number): SuiteOutcome => ({
    status: "failed",
    failures: Array.from({ length: count }, (_, index) => ({
      name: `property ${index}`,
      message: Array.from({ length: lines }, (_, line) => `${line} ${"x".repeat(width)}`).join(
        "\n",
      ),
    })),
  });

  /** Whether every fenced block in `text` is closed, for the fences renderReport writes: a line starting with
   *  ``` opens one, and only a bare ``` closes it (a "```json" inside a block is content). */
  function fencesBalanced(text: string): boolean {
    let open = false;
    for (const line of text.split("\n")) {
      if (!open && line.startsWith("```")) open = true;
      else if (open && line === "```") open = false;
    }
    return !open;
  }

  /** The bounds the action's block must meet, whether or not the report was cut. */
  function expectWithinBlock(report: string): { body: string; block: string } {
    const body = contractBody(report);
    expect(body.split("\n").length).toBeLessThanOrEqual(60);
    const block = actionBlock(report);
    expect(block.length).toBeLessThanOrEqual(8000);
    // Neither the action's line marker nor its character marker fired.
    expect(block).not.toMatch(/\.\.\. \(/);
    expect(fencesBalanced(block)).toBe(true);
    expect(body).toContain("Pin the regression");
    return { body, block };
  }

  it.each([
    ["many long failures", failing(10, 30, 200)],
    // Two 30-line failures: the cut lands inside a fence.
    ["two 30-line failures", failing(2, 30, 20)],
    ["five 8-line failures", failing(5, 8, 40)],
    ["one failure of very long lines", failing(1, 4, 3000)],
    // The preamble is 15 lines and a failure adds 4 around its message.
    ["one line over the line budget", failing(1, 60 - 15 - 4 + 1, 5)],
    // One character over the block: the action would cut from the end, where the fence is.
    ["one 7530-character line", failing(1, 1, 7528)],
    // A message whose first line looks like a fence opener is content inside ours.
    [
      "a message starting with a fenced JSON block",
      {
        status: "failed",
        failures: [{ name: "property 0", message: ["```json", ...Array(60).fill("x")].join("\n") }],
      } satisfies SuiteOutcome,
    ],
  ])("cuts a report the block cannot hold, closing the fence: %s", (_name, outcome) => {
    const { body } = expectWithinBlock(renderReport(OPTIONS, SUITE, outcome));
    expect(body.split("\n").at(-1)).toMatch(/^\.\.\. \d+ more line\(s\) in the run log\.$/);
  });

  it.each([
    ["two short failures", failing(2, 5, 40), 0],
    ["exactly the line budget", failing(1, 60 - 15 - 4, 5), 0],
    ["one 7480-character line", failing(1, 1, 7478), 7951],
    ["one 7500-character line", failing(1, 1, 7498), 7971],
    // The largest single line the block holds: exactly the action's cap.
    ["one 7529-character line", failing(1, 1, 7527), 8000],
  ])("keeps a report the block holds whole: %s", (_name, outcome, blockLength) => {
    const { body, block } = expectWithinBlock(renderReport(OPTIONS, SUITE, outcome));
    expect(body).not.toContain("more line(s)");
    for (const failure of outcome.status === "failed" ? outcome.failures : []) {
      expect(body).toContain(`### ${failure.name}`);
      expect(body).toContain(failure.message);
    }
    if (blockLength > 0) expect(block.length).toBe(blockLength);
  });

  it("keeps a whole first message when only a longer prefix fits: the real fence replaces the added one", () => {
    // cut(4) is one character over the block; cut(5), with the message's own
    // closing fence and a shorter omission count, is exactly 8000.
    const first = "x".repeat(7494);
    const outcome: SuiteOutcome = {
      status: "failed",
      failures: [
        { name: "property 0", message: first },
        { name: "property 1", message: `${"y".repeat(100)}\nb\nc` },
      ],
    };
    const { body, block } = expectWithinBlock(renderReport(OPTIONS, SUITE, outcome));
    expect(body).toContain(first);
    expect(block.length).toBe(8000);
  });

  it("control: a body that ignores the action's heading overflows the block it builds", () => {
    // A 7988-character body passes an 8000-character body budget; the block does not.
    const body = "x".repeat(7988);
    const block = actionBlock(`# Fuzz failure in unicode-text-fuzz\n${body}\n`);
    expect(block.length).toBe(8000);
    expect(block).toContain("... (truncated)");
  });

  it("describes a hang, a skipped suite, and a crash without a counterexample", () => {
    const hung = renderReport(OPTIONS, SUITE, { status: "timed-out", budgetMs: 90_000 });
    expect(hung).toContain("## Hung");
    expect(hung).toContain("still running 1.5 minutes after it started");
    expect(hung).toContain("45-minute wall clock");
    const skipped = renderReport(OPTIONS, SUITE, { status: "not-run" });
    expect(skipped).toContain("## Not run");
    expect(skipped).toContain("raise FUZZ_TIMEOUT_MINUTES");
    const crashed = renderReport(OPTIONS, SUITE, {
      status: "crashed",
      exitCode: 1,
      detail: "without writing a result file",
    });
    expect(crashed).toContain("## Crashed");
    expect(crashed).toContain("vitest exited with 1 without writing a result file");
    for (const report of [hung, skipped, crashed]) {
      expect(report.split("\n")[0]).toBe("# Fuzz failure in unicode-text-fuzz");
      expect(report).toContain(
        "bun run fuzz -- apps/extension/tests/lib/unicode-text-fuzz.test.ts",
      );
      // There is no counterexample to pin.
      expect(report).not.toContain("Pin the regression");
    }
  });
});

describe("runFuzz", () => {
  /** A scratch repository root holding empty copies of the real suites at
   *  their paths, so discovery, report paths and cleanup run against it and
   *  nothing lands in this repository. */
  function scratchRoot(): string {
    const root = mkdtempSync(join(tmpdir(), "fuzz-runner-"));
    for (const suite of allSuites(ROOT)) {
      mkdirSync(dirname(join(root, suite.path)), { recursive: true });
      writeFileSync(join(root, suite.path), "");
    }
    return root;
  }

  interface Drive {
    exit: number;
    reports: Record<string, string>;
    calls: Parameters<SuiteRunner>[];
  }

  /** Drives the orchestration with scripted outcomes; `elapse` says how much
   *  wall clock each suite consumes, on a clock the test owns. */
  async function drive(
    outcomes: Record<string, SuiteOutcome>,
    options: Partial<FuzzOptions> = {},
    elapse = 0,
  ): Promise<Drive> {
    const root = scratchRoot();
    const calls: Parameters<SuiteRunner>[] = [];
    let clock = 1_000_000;
    try {
      const runner: SuiteRunner = async (suite, env, budgetMs) => {
        calls.push([suite, env, budgetMs]);
        clock += elapse;
        const outcome = outcomes[suite.name];
        if (!outcome) throw new Error(`no outcome scripted for ${suite.name}`);
        return outcome;
      };
      const exit = await runFuzz(
        { ...OPTIONS, ...options },
        { root, runner, log: () => {}, now: () => clock },
      );
      const reports: Record<string, string> = {};
      for (const suite of allSuites(ROOT)) {
        const file = join(root, FAILURES_DIR, suite.name, "report.md");
        if (existsSync(file)) reports[suite.name] = readFileSync(file, "utf8");
      }
      if (Object.keys(reports).length === 0) {
        expect(existsSync(join(root, FAILURES_DIR))).toBe(false);
      }
      return { exit, reports, calls };
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const passed: SuiteOutcome = { status: "passed" };
  const allPassed = {
    "protocol-fuzz": passed,
    "unicode-text-fuzz": passed,
    "response-fuzz": passed,
  };

  it("exits 0 and writes no directory when every suite passes", async () => {
    const run = await drive(allPassed);
    expect(run.exit).toBe(0);
    expect(run.reports).toEqual({});
    expect(run.calls.map(([suite]) => suite.name)).toEqual([
      "protocol-fuzz",
      "unicode-text-fuzz",
      "response-fuzz",
    ]);
  });

  it("threads the seed and iterations to every suite and hands each the remaining wall clock", async () => {
    const run = await drive(allPassed, { seed: 9, iterations: 3, timeoutMinutes: 2 }, 30_000);
    expect(run.calls.map(([, env]) => env)).toEqual(
      Array(3).fill({ FUZZ_SEED: "9", FUZZ_ITERATIONS: "3" }),
    );
    expect(run.calls.map(([, , budgetMs]) => budgetMs)).toEqual([120_000, 90_000, 60_000]);
  });

  it("exits 1 and writes one report per red suite, named after the suite", async () => {
    const run = await drive({
      "protocol-fuzz": passed,
      "unicode-text-fuzz": {
        status: "failed",
        failures: [{ name: "chunkText > keeps order", message: 'Counterexample: ["x"]' }],
      },
      "response-fuzz": { status: "timed-out", budgetMs: 1_000 },
    });
    expect(run.exit).toBe(1);
    expect(Object.keys(run.reports).sort()).toEqual(["response-fuzz", "unicode-text-fuzz"]);
    expect(run.reports["unicode-text-fuzz"]?.split("\n")[0]).toBe(
      "# Fuzz failure in unicode-text-fuzz",
    );
    expect(run.reports["unicode-text-fuzz"]).toContain(
      "SEED=123 ITERATIONS=50 bun run fuzz -- apps/extension/tests/lib/unicode-text-fuzz.test.ts",
    );
    expect(run.reports["unicode-text-fuzz"]).toContain('Counterexample: ["x"]');
    expect(run.reports["response-fuzz"]).toContain("## Hung");
  });

  it("removes a previous run's reports before running", async () => {
    const root = scratchRoot();
    try {
      const stale = join(root, FAILURES_DIR, "stale-fuzz");
      mkdirSync(stale, { recursive: true });
      writeFileSync(join(stale, "report.md"), "# old\n");
      const exit = await runFuzz(
        { ...OPTIONS, files: [SUITE.path] },
        { root, runner: async () => passed, log: () => {} },
      );
      expect(exit).toBe(0);
      expect(existsSync(join(root, FAILURES_DIR))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports the suites left once the wall clock is spent as not run, and the run is red", async () => {
    // Each suite consumes 50 minutes of a 45 minute clock: the first one is
    // killed and reported, the other two never start and are reported too.
    const run = await drive(
      { ...allPassed, "protocol-fuzz": { status: "timed-out", budgetMs: 45 * 60_000 } },
      {},
      50 * 60_000,
    );
    expect(run.exit).toBe(1);
    expect(run.calls.map(([suite]) => suite.name)).toEqual(["protocol-fuzz"]);
    expect(Object.keys(run.reports).sort()).toEqual([
      "protocol-fuzz",
      "response-fuzz",
      "unicode-text-fuzz",
    ]);
    expect(run.reports["protocol-fuzz"]).toContain("## Hung");
    expect(run.reports["response-fuzz"]).toContain("## Not run");
  });

  it("is red when the clock runs out after a green suite, instead of calling the rest passed", async () => {
    // The first suite passes but takes the whole clock; nothing else ran.
    const run = await drive(allPassed, {}, 45 * 60_000);
    expect(run.exit).toBe(1);
    expect(run.calls.map(([suite]) => suite.name)).toEqual(["protocol-fuzz"]);
    expect(Object.keys(run.reports).sort()).toEqual(["response-fuzz", "unicode-text-fuzz"]);
  });
});

describe("runWithVitest (the real vitest path)", () => {
  /** A throwaway suite under apps/extension/tests, so vitest's config and
   *  include patterns apply to it; removed after the test. */
  function scratchSuite(source: string): { suite: Suite; remove: () => void } {
    const name = `scratch-${process.pid}-${Date.now()}-fuzz`;
    const vitestPath = `tests/scripts/${name}.test.ts`;
    const absolute = join(ROOT, "apps/extension", vitestPath);
    writeFileSync(absolute, source);
    return {
      suite: { name, path: `apps/extension/${vitestPath}`, vitestPath },
      remove: () => rmSync(absolute, { force: true }),
    };
  }

  const SLEEPING = `import { it } from "vitest";
it("never ends", () => new Promise((settle) => setTimeout(settle, 120_000)));
`;

  /** A private base for the runner's scratch directories (other runners may
   *  share the OS tmp dir), so "nothing left behind" is this runner's alone. */
  async function withRunner<T>(
    body: (runner: SuiteRunner, tmp: string) => Promise<T>,
  ): Promise<{ result: T; leftBehind: string[] }> {
    const tmp = mkdtempSync(join(tmpdir(), "fuzz-runner-tmp-"));
    try {
      const result = await body(runWithVitest(ROOT, { stdio: "ignore", tmp }), tmp);
      return { result, leftBehind: readdirSync(tmp) };
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }

  interface Process {
    pid: number;
    pgid: number;
    args: string;
  }

  /** The process table, read (never signalled) through `ps`. */
  function processes(): Process[] {
    return execFileSync("ps", ["-eo", "pid,pgid,args"], { encoding: "utf8" })
      .split("\n")
      .slice(1)
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const [pid = "", pgid = "", ...args] = line.split(/\s+/);
        return { pid: Number(pid), pgid: Number(pgid), args: args.join(" ") };
      });
  }

  async function eventually<T>(read: () => T | undefined, ms: number): Promise<T | undefined> {
    const end = Date.now() + ms;
    for (;;) {
      const value = read();
      if (value !== undefined || Date.now() > end) return value;
      await new Promise((settle) => setTimeout(settle, 100));
    }
  }

  it("kills a suite still running at the deadline, with vitest's worker fork, and reports it as timed out, leaving no process and no scratch dir", async () => {
    const { suite, remove } = scratchSuite(SLEEPING);
    try {
      const { result, leftBehind } = await withRunner(async (runner) => {
        const run = runner(suite, {}, 4_000);
        // The vitest leader names the suite file; its worker fork shares its
        // process group (the runner spawned it detached, as the group leader).
        const groupOf = (table: Process[]) =>
          table.find((entry) => entry.args.includes(suite.vitestPath))?.pgid;
        // Wait for the fork too: the leader shows up first, on its own.
        const group = await eventually(() => {
          const table = processes();
          const pgid = groupOf(table);
          return table.filter((entry) => entry.pgid === pgid).length >= 2 ? pgid : undefined;
        }, 3_000);
        expect(group).toBeDefined();
        const members = () => processes().filter((entry) => entry.pgid === group);
        const outcome = await run;
        // SIGKILL to the group is sent as the leader exits; give it a moment.
        await eventually(() => (members().length === 0 ? true : undefined), 3_000);
        return { outcome, survivors: members() };
      });
      expect(result.outcome).toEqual({ status: "timed-out", budgetMs: 4_000 });
      expect(result.survivors).toEqual([]);
      expect(leftBehind).toEqual([]);
    } finally {
      remove();
    }
  }, 30_000);

  it("stops the suite on SIGINT, stays attached for a second one, cleans up, and ends the run as interrupted", async () => {
    const { suite, remove } = scratchSuite(SLEEPING);
    const listeners = () => process.listenerCount("SIGINT");
    const idle = listeners();
    try {
      const { result, leftBehind } = await withRunner(async (runner) => {
        const run = runner(suite, {}, 60_000);
        await new Promise((settle) => setTimeout(settle, 1_500));
        expect(listeners()).toBe(idle + 1);
        // The listeners run; the worker itself is not signalled. A second
        // signal (an impatient Ctrl-C) still finds the runner's listener.
        process.emit("SIGINT", "SIGINT");
        expect(listeners()).toBe(idle + 1);
        process.emit("SIGINT", "SIGINT");
        return run.then(
          () => "resolved",
          (error: unknown) => error,
        );
      });
      expect(result).toBeInstanceOf(Interrupted);
      expect(result).toMatchObject({ signal: "SIGINT" });
      expect(leftBehind).toEqual([]);
      expect(listeners()).toBe(idle);
    } finally {
      remove();
    }
  }, 30_000);

  it("reports a suite that counts no test as crashed, not passed", async () => {
    const { suite, remove } = scratchSuite("export {};\n");
    try {
      const { result: outcome } = await withRunner((runner) => runner(suite, {}, 60_000));
      expect(outcome).toEqual({
        status: "crashed",
        exitCode: 0,
        detail: "with a result file that counts no test",
      });
    } finally {
      remove();
    }
  }, 30_000);
});
