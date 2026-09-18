import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { scanTree } from "../../../../scripts/check-yaml.mts";

const ROOT = resolve(__dirname, "../../../..");

describe("YAML policy check", () => {
  it("reports unquoted string values and parser diagnostics per file, exempting workflow YAML and the sync's registration file", () => {
    const fixture = mkdtempSync(join(tmpdir(), "check-yaml-"));
    try {
      const files: Record<string, string> = {
        "clean.yml": 'name: "ok"\nlist:\n  - "a"\ncount: 1\nnote: |\n  free text\n',
        // The unresolved tag is a parser warning yamllint accepts; the quoting rule still runs on that file.
        "bad.yml": 'a: b\nc: "d"\ne: [f, "g"]\nh: !typo "ok"\n',
        "nested/broken.yaml": 'a: "1"\nb: [\n',
        // Quoting is not enforced for workflows or the platform's registration file; parser diagnostics still are.
        ".github/workflows/ci.yml": 'on: push\nx: !typo "ok"\n',
        ".repo-platform.yml": "modules:\n  - bun\n",
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
          ".github/workflows/ci.yml:2 Unresolved tag: !typo at line 2, column 4:",
          "bad.yml:4 Unresolved tag: !typo at line 4, column 4:",
          'bad.yml:1 string value not double-quoted: "b"',
          'bad.yml:3 string value not double-quoted: "f"',
          "nested/broken.yaml:3 Flow sequence in block collection must be sufficiently indented and end with a ] at line 3, column 1:",
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
