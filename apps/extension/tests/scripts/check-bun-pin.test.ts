import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageJsonFindings,
  scanRepo,
  workflowFindings,
} from "../../../../scripts/check-bun-pin.mts";

const ROOT = resolve(__dirname, "../../../..");

const workflow = (steps: string, header = "# Repo-owned checks.") => `${header}
name: Checks
on:
  workflow_call:
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
${steps}
      - run: bun install --frozen-lockfile
`;

const PIN_STEP = `
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version`;
const OVERRIDE_STEP = `
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: "1.3.9"`;
const DRIFT_STEP = `
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: package.json`;

describe("single bun pin check", () => {
  it.each([
    ["reads .bun-version", workflow(PIN_STEP), []],
    ["pins another exact version inline (the documented override)", workflow(OVERRIDE_STEP), []],
    [
      "overrides and still names the pin file",
      workflow(`${OVERRIDE_STEP}\n          bun-version-file: .bun-version`),
      [],
    ],
    [
      "reads package.json",
      workflow(DRIFT_STEP),
      ['wf.yml: job check step 2: bun-version-file is "package.json", expected .bun-version'],
    ],
    [
      "overrides but leaves a stale bun-version-file",
      workflow(`${OVERRIDE_STEP}\n          bun-version-file: package.json`),
      ['wf.yml: job check step 2: bun-version-file is "package.json", expected .bun-version'],
    ],
    [
      "floats on bun-version: latest",
      workflow(`
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: latest`),
      ['wf.yml: job check step 2: bun-version "latest" is not an exact x.y.z pin'],
    ],
    [
      "has no with block (setup-bun's own lookup order)",
      workflow(`
      - uses: oven-sh/setup-bun@v2`),
      [
        "wf.yml: job check step 2: reads no pin; set bun-version-file: .bun-version (or a bun-version override)",
      ],
    ],
    [
      "spells the action and input in another case (Actions matches both case-insensitively)",
      workflow(`
      - uses: Oven-Sh/Setup-Bun@v2
        with:
          Bun-Version-File: package.json`),
      ['wf.yml: job check step 2: bun-version-file is "package.json", expected .bun-version'],
    ],
  ])("workflow that %s", (_label, text, findings) => {
    expect(workflowFindings("wf.yml", text)).toEqual({ steps: 1, findings });
  });

  it("counts no step in a workflow without setup-bun", () => {
    const text = workflow(`
      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json`);
    expect(workflowFindings("wf.yml", text)).toEqual({ steps: 0, findings: [] });
  });

  it.each([
    [
      '{"name": "x", "packageManager": "bun@1.3.9"}',
      [
        'package.json: packageManager "bun@1.3.9" is a second bun pin; .bun-version is the only one',
      ],
    ],
    ['{"name": "x"}', []],
  ])("package.json %s yields %j", (text, expected) => {
    expect(packageJsonFindings(text)).toEqual(expected);
  });

  describe("repository scan", () => {
    it("checks repo-owned workflows, skips managed ones, and reads package.json", () => {
      const fixture = mkdtempSync(join(tmpdir(), "check-bun-pin-"));
      try {
        const workflows = join(fixture, ".github/workflows");
        mkdirSync(workflows, { recursive: true });
        const files: Record<string, string> = {
          // Mentioning the managed files is not the managed header.
          "checks.yml": workflow(
            PIN_STEP,
            "# Called by ci.yml, which is managed by Vivswan/repo-platform.",
          ),
          "override.yml": workflow(OVERRIDE_STEP),
          "drift.yml": workflow(DRIFT_STEP),
          // Drift inside a managed file is the sync's, so it must not be reported.
          "managed.yml": workflow(
            DRIFT_STEP,
            "# This file is managed by Vivswan/repo-platform.\n# Local edits are replaced on the next sync.",
          ),
          "notes.txt": "not a workflow",
        };
        for (const [name, text] of Object.entries(files)) {
          writeFileSync(join(workflows, name), text);
        }
        writeFileSync(
          join(fixture, "package.json"),
          '{"name": "x", "packageManager": "bun@1.3.9"}',
        );

        expect(scanRepo(fixture)).toEqual({
          inspected: 3,
          skipped: 1,
          findings: [
            '.github/workflows/drift.yml: job check step 2: bun-version-file is "package.json", expected .bun-version',
            'package.json: packageManager "bun@1.3.9" is a second bun pin; .bun-version is the only one',
          ],
        });
      } finally {
        rmSync(fixture, { recursive: true, force: true });
      }
    });

    it("finds this repository clean", () => {
      expect(scanRepo(ROOT).findings).toEqual([]);
    });
  });
});
