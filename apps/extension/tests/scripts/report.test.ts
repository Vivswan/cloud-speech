import { afterEach, describe, expect, it, vi } from "vitest";
import { runCheck, type ScanResult } from "../../../../scripts/lib/report.mts";

/** Thrown in place of the real exit so the check stops where the process would. */
class ExitSignal extends Error {
  constructor(readonly code: unknown) {
    super(`process.exit(${String(code)})`);
  }
}

interface Observed {
  exit: unknown;
  stderr: string[];
  stdout: string[];
}

async function observe(run: () => Promise<unknown>): Promise<Observed> {
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new ExitSignal(code);
  });
  const error = vi.spyOn(console, "error").mockImplementation(() => {});
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  let exited: unknown = null;
  try {
    await run();
  } catch (thrown) {
    if (!(thrown instanceof ExitSignal)) throw thrown;
    exited = thrown.code;
  }
  return {
    exit: exited,
    stderr: error.mock.calls.map((call) => call.join(" ")),
    stdout: log.mock.calls.map((call) => call.join(" ")),
  };
}

describe("runCheck", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each<{ name: string; result: ScanResult; outcome: Observed & { scanned: number } }>([
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
  ])("$name", async ({ result, outcome }) => {
    const scan = vi.fn(() => result);
    const observed = await observe(() =>
      runCheck({
        scan,
        empty: "nothing scanned",
        failed: (count) => `${count} problem(s)`,
        passed: ({ inspected }) => `passed (${inspected})`,
      }),
    );
    expect({ scanned: scan.mock.calls.length, ...observed }).toEqual(outcome);
  });

  // Vitest reports import.meta.main as false, so an imported check script never runs its scan.
  it("does nothing for a check script that is imported rather than run", async () => {
    const observed = await observe(() => import("../../../../scripts/checks/check-compat.mts"));
    expect(observed).toEqual({ exit: null, stderr: [], stdout: [] });
  });
});
