#!/usr/bin/env bun
// Backwards-compatibility code lives ONLY in apps/extension/src/migrations/; every other extension
// source file is scanned for the vocabulary such code carries, so an "old shape" branch cannot quietly
// grow outside the folder. Bare "compat" is deliberately NOT matched: "OpenAI-compatible" is product
// prose.
//
//   camelCase / snake_case parts count as words   -> `legacySettings`, `migrate_old` are hits
//   import specifiers into @/migrations            -> exempt; the wiring must name them
//   identifiers the folder exports                 -> exempt; callers import and call that API

import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { runCheck } from "./lib/report.mts";
import { walk } from "./lib/walk.mts";

/** Relative to the repository root the caller supplies: tests import this module with their own root. */
const SCAN_DIR = "apps/extension/src";
const EXEMPT_DIR = join(SCAN_DIR, "migrations");
const SOURCE_EXTENSIONS = [".ts", ".tsx"];

const COMPAT_TOKEN =
  /\blegacy\b|\bdeprecated\b|\bbackwards?[ -]compat|\bold (format|shape|schema|keys?)\b|\bmigrat(e|es|ed|ing|ion|ions)\b/i;
const MIGRATIONS_IMPORT = /(["'])@\/migrations(?:\/[^"']*)?\1/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const EXPORTED_DECLARATION =
  /^export\s+(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

export function exemptIdentifiers(root: string): Set<string> {
  const names = new Set<string>();
  for (const file of walk(join(root, EXEMPT_DIR), { extensions: SOURCE_EXTENSIONS })) {
    for (const match of readFileSync(file, "utf8").matchAll(EXPORTED_DECLARATION)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/** Word boundaries where identifiers hide them.
 *    `legacySettings` -> `legacy Settings`, `old_shape` -> `old shape`, `XMLMigration` -> `XML Migration` */
function splitWords(text: string): string {
  return text
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
}

export function compatToken(line: string, exempt: ReadonlySet<string>): string | null {
  const stripped = line
    .replace(MIGRATIONS_IMPORT, "")
    .replace(IDENTIFIER, (identifier) => (exempt.has(identifier) ? "" : identifier));
  const match = COMPAT_TOKEN.exec(splitWords(stripped));
  return match ? match[0] : null;
}

export function scanTree(root: string): { inspected: number; findings: string[] } {
  const exempt = exemptIdentifiers(root);
  const findings: string[] = [];
  let inspected = 0;
  const scanRoot = join(root, SCAN_DIR);
  const exemptRoot = join(root, EXEMPT_DIR);
  for (const file of walk(scanRoot, { extensions: SOURCE_EXTENSIONS, exclude: [exemptRoot] })) {
    inspected++;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const token = compatToken(line, exempt);
        if (token) findings.push(`${relative(root, file)}:${index + 1}: ${token}`);
      });
  }
  return { inspected, findings };
}

runCheck(import.meta.url, {
  scan: () => scanTree(fileURLToPath(new URL("..", import.meta.url))),
  empty: `no TypeScript sources found under ${SCAN_DIR}`,
  failed: (count) => `${count} compatibility token(s) outside ${EXEMPT_DIR}/ (move the code there)`,
  passed: ({ inspected }) => `Compatibility-code placement check passed (${inspected} files).`,
});
