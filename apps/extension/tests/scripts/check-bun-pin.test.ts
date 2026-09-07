import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  packageJsonFindings,
  scanRepo,
  workflowFindings,
} from "../../../../scripts/check-bun-pin.mts";

const ROOT = resolve(__dirname, "../../../..");

const workflow = (steps: string) => `
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

describe("single bun pin check", () => {
  it.each([
    [
      "reads .bun-version",
      workflow(`
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: .bun-version`),
      { steps: 1, findings: [] },
    ],
    [
      "reads package.json",
      workflow(`
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version-file: package.json`),
      {
        steps: 1,
        findings: [
          'wf.yml: job check step 2: bun-version-file is "package.json", expected .bun-version',
        ],
      },
    ],
    [
      "pins bun-version inline",
      workflow(`
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.3.9`),
      {
        steps: 1,
        findings: [
          "wf.yml: job check step 2: sets bun-version; read the pin with bun-version-file: .bun-version",
          "wf.yml: job check step 2: bun-version-file is undefined, expected .bun-version",
        ],
      },
    ],
    [
      "has no with block (setup-bun's own default)",
      workflow(`
      - uses: oven-sh/setup-bun@v2`),
      {
        steps: 1,
        findings: [
          "wf.yml: job check step 2: bun-version-file is undefined, expected .bun-version",
        ],
      },
    ],
    [
      "has no setup-bun step",
      workflow(`
      - uses: actions/setup-node@v4
        with:
          node-version-file: package.json`),
      { steps: 0, findings: [] },
    ],
    [
      "spells the action and input in another case (Actions matches both case-insensitively)",
      workflow(`
      - uses: Oven-Sh/Setup-Bun@v2
        with:
          BUN-VERSION: "1.3.9"
          bun-version-file: .bun-version`),
      {
        steps: 1,
        findings: [
          "wf.yml: job check step 2: sets bun-version; read the pin with bun-version-file: .bun-version",
        ],
      },
    ],
  ])("workflow that %s", (_label, text, expected) => {
    expect(workflowFindings("wf.yml", text)).toEqual(expected);
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

  // The count is exact on purpose: a workflow file the scan skipped would
  // otherwise pass unnoticed. Adding or removing a setup-bun step updates it.
  it("finds every setup-bun step in the repository reading .bun-version", () => {
    expect(scanRepo(ROOT)).toEqual({ steps: 6, findings: [] });
  });
});
