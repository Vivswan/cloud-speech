#!/usr/bin/env bun
// Bun-native replacement for yamllint (no system install needed). Enforces
// the repo's YAML policy:
//
//   - every file parses (the `yaml` package also reports duplicate keys)
//   - no tabs in indentation, no trailing whitespace, final newline present
//   - string VALUES are always double-quoted (keys and block scalars are
//     exempt, matching yamllint's quoted-strings rule this replaces).
//     Skipped for .github/ (workflow files keep their conventional style)
//     and .repo-platform.yml (written by the fleet sync with plain scalars).
//
// Runs under bun (not node) so it can import the workspace `yaml` package.
// Run: bun scripts/check-yaml.mts   (wired into `bun run check`); the scan
// itself is unit-tested from apps/extension/tests/scripts/check-yaml.test.ts.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type Node, parseAllDocuments, visit } from "yaml";
import { runCheck } from "./lib/report.mts";
import { walk } from "./lib/walk.mts";

const YAML_EXTENSIONS = [".yml", ".yaml"];

/** Problems in one file as `<line> <message>`, in the order the checks run:
 *  whitespace, parse, then quoting (the quoting pass is skipped for exempt
 *  paths, given as forward-slash paths relative to the repo root). */
function fileFindings(rel: string, content: string): string[] {
  const findings: string[] = [];
  const fail = (line: number, message: string) => {
    findings.push(`${line} ${message}`);
  };

  content.split("\n").forEach((line, index) => {
    if (/^\s*\t/.test(line)) fail(index + 1, "tab in indentation (use spaces)");
    if (/[ \t]+$/.test(line)) fail(index + 1, "trailing whitespace");
  });
  if (content.length > 0 && !content.endsWith("\n")) {
    fail(content.split("\n").length, "missing final newline");
  }

  const documents = parseAllDocuments(content, { prettyErrors: true });
  for (const doc of documents) {
    for (const issue of [...doc.errors, ...doc.warnings]) {
      fail(issue.linePos?.[0]?.line ?? 1, issue.message.split("\n")[0] ?? issue.message);
    }
  }

  // Workflow/repo config keeps conventional style, and .repo-platform.yml
  // is written by the fleet sync with plain scalars; data-like YAML
  // (locales, lint configs) must double-quote every string value.
  if (rel.startsWith(".github/") || rel === ".repo-platform.yml") return findings;
  const lineOf = (node: Node) => {
    const offset = node.range?.[0] ?? 0;
    return content.slice(0, offset).split("\n").length;
  };
  for (const doc of documents) {
    visit(doc, {
      // biome-ignore lint/style/useNamingConvention: yaml's visitor keys are node type names
      Scalar(key, node) {
        if (key === "key") return;
        if (typeof node.value !== "string") return;
        if (node.type === "QUOTE_DOUBLE") return;
        if (node.type === "BLOCK_LITERAL" || node.type === "BLOCK_FOLDED") return;
        fail(lineOf(node), `string value not double-quoted: ${JSON.stringify(node.value)}`);
      },
    });
  }
  return findings;
}

/** Every YAML file under `root`: findings as `path:line message` with paths
 *  relative to `root`; `inspected` counts the files read. */
export function scanTree(root: string): { inspected: number; findings: string[] } {
  const findings: string[] = [];
  let inspected = 0;
  for (const path of walk(root, { extensions: YAML_EXTENSIONS })) {
    inspected++;
    const rel = relative(root, path);
    // Forward slashes even on Windows, for the .github/ prefix test.
    for (const finding of fileFindings(rel.replaceAll("\\", "/"), readFileSync(path, "utf-8"))) {
      findings.push(`${rel}:${finding}`);
    }
  }
  return { inspected, findings };
}

runCheck(import.meta.url, {
  scan: () => scanTree(fileURLToPath(new URL("..", import.meta.url))),
  empty: "no YAML files found under the repo root",
  failed: (count) => `${count} YAML problem(s).`,
  passed: () => "YAML check passed.",
});
