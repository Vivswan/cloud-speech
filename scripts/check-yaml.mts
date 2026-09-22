#!/usr/bin/env bun
// One YAML rule the fleet's yamllint (the managed .yamllint, run by ci.yml's `ci` job) does not carry:
// string values are double-quoted. Keys and block scalars are exempt, as in yamllint's quoted-strings rule.
// Skipped for .github/ (workflows keep their conventional style) and .repo-platform.yml (written by
// the fleet sync with plain scalars). yamllint owns syntax, duplicate keys, and whitespace; the parser's own
// diagnostics still surface here because an unparsed file cannot be judged, and its unresolved-tag
// warning (`!typo "x"`) is one yamllint accepts.

import { readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { type Node, parseAllDocuments, visit } from "yaml";
import { runCheck } from "./lib/report.mts";
import { walk } from "./lib/walk.mts";

const YAML_EXTENSIONS = [".yml", ".yaml"];

/** `rel` is a forward-slash path from the repo root; the exemptions test its prefix. */
function fileFindings(rel: string, content: string): string[] {
  const quotingApplies = !(rel.startsWith(".github/") || rel === ".repo-platform.yml");
  const findings: string[] = [];
  const fail = (line: number, message: string) => {
    findings.push(`${line} ${message}`);
  };
  const lineOf = (node: Node) => {
    const offset = node.range?.[0] ?? 0;
    return content.slice(0, offset).split("\n").length;
  };

  for (const doc of parseAllDocuments(content, { prettyErrors: true })) {
    for (const issue of [...doc.errors, ...doc.warnings]) {
      fail(issue.linePos?.[0]?.line ?? 1, issue.message.split("\n")[0] ?? issue.message);
    }
    if (doc.errors.length > 0 || !quotingApplies) continue;
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

await runCheck(import.meta.url, {
  scan: () => scanTree(fileURLToPath(new URL("..", import.meta.url))),
  empty: "no YAML files found under the repo root",
  failed: (count) => `${count} YAML problem(s).`,
  passed: () => "YAML check passed.",
});
