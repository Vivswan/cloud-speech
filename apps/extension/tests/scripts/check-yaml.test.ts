import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanTree } from "../../../../scripts/check-yaml.mts";

const ROOT = resolve(__dirname, "../../../..");

describe("YAML policy check", () => {
  it("reports whitespace, parse, and quoting problems per file, exempting workflow and copier YAML", () => {
    const fixture = mkdtempSync(join(tmpdir(), "check-yaml-"));
    try {
      const files: Record<string, string> = {
        "clean.yml": 'name: "ok"\nlist:\n  - "a"\ncount: 1\nnote: |\n  free text\n',
        "bad.yml": 'a: b  \nc: "d"\n\td: 1',
        "nested/dup.yaml": 'a: "1"\na: "2"\n',
        // Quoting is not enforced for workflows or copier's answers file.
        ".github/workflows/ci.yml": "on: push\n",
        ".copier-answers.yml": "_commit: abc123\n",
        // Skipped directories are never inspected.
        "node_modules/pkg/config.yml": "bad: value  \n",
        "notes.txt": "not yaml",
      };
      for (const [name, text] of Object.entries(files)) {
        mkdirSync(dirname(join(fixture, name)), { recursive: true });
        writeFileSync(join(fixture, name), text);
      }

      expect(scanTree(fixture)).toEqual({
        inspected: 5,
        findings: [
          "bad.yml:1 trailing whitespace",
          "bad.yml:3 tab in indentation (use spaces)",
          "bad.yml:3 missing final newline",
          "bad.yml:3 Tabs are not allowed as indentation at line 3, column 1:",
          'bad.yml:1 string value not double-quoted: "b"',
          "nested/dup.yaml:2 Map keys must be unique at line 2, column 1:",
        ],
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("finds this repository clean", () => {
    expect(scanTree(ROOT).findings).toEqual([]);
  });
});
