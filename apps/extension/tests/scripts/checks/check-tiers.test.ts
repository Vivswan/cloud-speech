// tier: pr
// The tier header is a comment no runner reads: only this census notices a test file without one, or
// one claiming a tier no workflow runs the file under.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanTree } from "../../../../../scripts/checks/check-tiers.mts";

const ROOT = resolve(__dirname, "../../../../..");

describe("test tier census", () => {
  it("finds every test file in this repository headed with the tier its runner has", () => {
    const { inspected, findings } = scanTree(ROOT);
    expect(findings).toEqual([]);
    expect(inspected).toBeGreaterThan(100);
  });

  it("reports a missing, unknown, and unrun tier, and inspects only what a runner would select", () => {
    const fixture = mkdtempSync(join(tmpdir(), "check-tiers-"));
    try {
      const files: Record<string, string> = {
        "apps/a/tests/good.test.ts": '// tier: pr\nimport { it } from "vitest";\n',
        "apps/a/tests/ui/headless.spec.tsx": 'import { render } from "@testing-library/react";\n',
        "apps/a/tests/e2e/weekly.spec.ts": "// tier: weekly\n",
        "apps/b/tests/deep.test.ts": "// tier: release-gate\n",
        "apps/b/tests/bun_test.mjs": "",
        "apps/b/tests/helpers.ts": "export const fixture = 1;\n",
        "apps/b/tests/testing.ts": "export const testing = 1;\n",
        "apps/b/node_modules/dep/tests/vendored.test.ts": "",
      };
      for (const [path, content] of Object.entries(files)) {
        mkdirSync(join(fixture, path, ".."), { recursive: true });
        writeFileSync(join(fixture, path), content);
      }

      expect(scanTree(fixture)).toEqual({
        inspected: 5,
        findings: [
          'apps/a/tests/e2e/weekly.spec.ts:1: unknown tier "weekly" (one of pr, release-gate, nightly)',
          'apps/a/tests/ui/headless.spec.tsx:1: no tier header (first line must be "// tier: <pr|release-gate|nightly>")',
          'apps/b/tests/bun_test.mjs:1: no tier header (first line must be "// tier: <pr|release-gate|nightly>")',
          'apps/b/tests/deep.test.ts:1: tier "release-gate", but checks.yml runs it on every PR (pr); no runner selects by tier',
        ],
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
