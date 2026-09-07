import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck, type ScanResult } from "../../../../scripts/lib/report.mts";

const ROOT = resolve(__dirname, "../../../..");
// runCheck runs its scan only for the module bun invoked directly. Under
// Vitest that entry is the test worker, so its URL stands in for a script run
// from the command line; the report module's own URL is any other import.
const ENTRY_URL = pathToFileURL(process.argv[1] ?? "").href;
const IMPORTED_URL = pathToFileURL(resolve(ROOT, "scripts/lib/report.mts")).href;

/** Thrown in place of the real exit so the check stops where the process would. */
class ExitSignal extends Error {
  constructor(readonly code: unknown) {
    super(`process.exit(${String(code)})`);
  }
}

interface Outcome {
  scanned: number;
  exit: unknown;
  stderr: string[];
  stdout: string[];
}

function drive(result: ScanResult, moduleUrl: string): Outcome {
  const scan = vi.fn(() => result);
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitSignal(code);
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let exited: unknown = null;
  try {
    runCheck(moduleUrl, {
      scan,
      empty: "nothing scanned",
      failed: (count) => `${count} problem(s)`,
      passed: ({ inspected }) => `passed (${inspected})`,
    });
  } catch (thrown) {
    if (!(thrown instanceof ExitSignal)) throw thrown;
    exited = thrown.code;
  }
  return {
    scanned: scan.mock.calls.length,
    exit: exited,
    stderr: error.mock.calls.map((call) => call.join(" ")),
    stdout: log.mock.calls.map((call) => call.join(" ")),
  };
}

describe("runCheck", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<{ name: string; result: ScanResult; outcome: Outcome }>([
    {
      name: "prints every finding, the count, and exits 1",
      result: { inspected: 3, findings: ["a.ts:1: legacy", "b.ts:7: old"] },
      outcome: {
        scanned: 1,
        exit: 1,
        stderr: ["x a.ts:1: legacy", "x b.ts:7: old", "\n2 problem(s)"],
        stdout: [],
      },
    },
    {
      name: "fails a scan that inspected nothing, even without findings",
      result: { inspected: 0, findings: [] },
      outcome: { scanned: 1, exit: 1, stderr: ["x nothing scanned"], stdout: [] },
    },
    {
      name: "reports the empty scan ahead of any finding it still produced",
      result: { inspected: 0, findings: ["a.ts:1: legacy"] },
      outcome: { scanned: 1, exit: 1, stderr: ["x nothing scanned"], stdout: [] },
    },
    {
      name: "prints the pass line and does not exit on a clean scan",
      result: { inspected: 7, findings: [] },
      outcome: { scanned: 1, exit: null, stderr: [], stdout: ["passed (7)"] },
    },
  ])("$name", ({ result, outcome }) => {
    expect(drive(result, ENTRY_URL)).toEqual(outcome);
  });

  it("does nothing for a module that is imported rather than run", () => {
    expect(drive({ inspected: 0, findings: ["a.ts:1: legacy"] }, IMPORTED_URL)).toEqual({
      scanned: 0,
      exit: null,
      stderr: [],
      stdout: [],
    });
  });
});
