import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// The two facts about release-gate.yml that nothing else reports. GitHub rejects the rest of the hook's contract
// at call time, and actionlint and zizmor cover the syntax.

/** Every workflow of the repository, the managed caller among them. */
const WORKFLOWS = resolve(__dirname, "../../../../.github/workflows");

/** A starter the sync wrote once and never rewrites, so what this test pins is the repository's own. */
const GATE = "release-gate.yml";

/** The sync's own caller of the gate, left out of the repository-side count. */
const MANAGED_CALLER = "ci.yml";

/** The two spellings GitHub resolves to this repository's own file at the same commit. */
const CALLS_GATE = /^(\.|\$)\/\.github\/workflows\/release-gate\.yml$/;

/** Both spellings GitHub reads a workflow from. */
const WORKFLOW_FILE = /\.ya?ml$/;

type Job = { uses?: string; "timeout-minutes"?: unknown };
const jobs = (file: string): [string, Job][] =>
  Object.entries(
    (parse(readFileSync(join(WORKFLOWS, file), "utf8")).jobs ?? {}) as Record<string, Job>,
  );

describe("release-gate.yml", () => {
  // GitHub's default job timeout is six hours, and a job without its own runs that long in silence. A number or
  // an expression both count; only an absent or blank value is the fault.
  it("gives every job a timeout", () => {
    const untimed = jobs(GATE)
      .filter(([, job]) => {
        const timeout = job["timeout-minutes"];
        return timeout === undefined || timeout === null || timeout === "";
      })
      .map(([id]) => id);
    expect(untimed).toEqual([]);
  });

  // A second repository-side call (a job in checks.yml, a second one in the nightly) runs the gate twice with no
  // error. The managed ci.yml's call is the platform's and is not counted.
  it("is called by exactly one repository-owned job", () => {
    const callers = readdirSync(WORKFLOWS)
      .filter((file) => WORKFLOW_FILE.test(file) && file !== MANAGED_CALLER)
      .flatMap((file) =>
        jobs(file)
          .filter(([, job]) => typeof job.uses === "string" && CALLS_GATE.test(job.uses))
          .map(([id]) => `${file}:${id}`),
      );
    expect(callers, callers.join(", ")).toHaveLength(1);
  });
});
