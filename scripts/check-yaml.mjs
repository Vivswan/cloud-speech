#!/usr/bin/env bun
// Bun-native replacement for yamllint (no system install needed). Enforces
// the repo's YAML policy:
//
//   - every file parses (the `yaml` package also reports duplicate keys)
//   - no tabs in indentation, no trailing whitespace, final newline present
//   - string VALUES are always double-quoted (keys and block scalars are
//     exempt, matching yamllint's quoted-strings rule this replaces).
//     Skipped for .github/ (workflow files keep their conventional style).
//
// Runs under bun (not node) so it can import the workspace `yaml` package.
// Run: bun scripts/check-yaml.mjs   (wired into `bun run check`)

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAllDocuments, visit } from "yaml";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".output",
  ".wxt",
  ".astro",
  "dist",
  "coverage",
  "sources",
  ".claude",
]);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(path);
    } else if (entry.endsWith(".yml") || entry.endsWith(".yaml")) {
      yield path;
    }
  }
}

const failures = [];
const fail = (path, line, message) => {
  failures.push(`${relative(ROOT, path)}:${line} ${message}`);
};

for (const path of walk(ROOT)) {
  const content = readFileSync(path, "utf-8");
  // Forward slashes even on Windows, for the .github/ prefix test below.
  const rel = relative(ROOT, path).replaceAll("\\", "/");

  content.split("\n").forEach((line, index) => {
    if (/^\s*\t/.test(line)) fail(path, index + 1, "tab in indentation (use spaces)");
    if (/[ \t]+$/.test(line)) fail(path, index + 1, "trailing whitespace");
  });
  if (content.length > 0 && !content.endsWith("\n")) {
    fail(path, content.split("\n").length, "missing final newline");
  }

  const documents = parseAllDocuments(content, { prettyErrors: true });
  for (const doc of documents) {
    for (const issue of [...doc.errors, ...doc.warnings]) {
      fail(path, issue.linePos?.[0]?.line ?? 1, issue.message.split("\n")[0]);
    }
  }

  // Workflow/repo config keeps conventional style; data-like YAML (locales,
  // lint configs) must double-quote every string value.
  if (rel.startsWith(".github/")) continue;
  const lineOf = (node) => {
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
        fail(path, lineOf(node), `string value not double-quoted: ${JSON.stringify(node.value)}`);
      },
    });
  }
}

if (failures.length > 0) {
  console.error("YAML check failures:\n");
  for (const failure of failures) console.error(`  ${failure}`);
  console.error(`\n${failures.length} YAML problem(s).`);
  process.exit(1);
}
console.log("YAML check passed.");
