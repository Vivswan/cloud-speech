#!/usr/bin/env bun
// Backwards-compatibility code lives ONLY in apps/extension/src/migrations/.
// This scans every other extension source file for the vocabulary such code
// carries and fails on any hit, so an "old shape" branch cannot quietly grow
// outside the folder. Lines are split into words first (camelCase and
// snake_case parts count as words), so `legacySettings` and `migrate_old`
// are hits. Two things are exempt because the wiring must name them: import
// specifiers pointing into @/migrations, and the exact identifiers the folder
// exports (callers import and call that API). Bare "compat" is deliberately
// NOT matched: "OpenAI-compatible" is product prose.
// Runs in `bun run check` (scripts/check.mjs); the scan itself is
// unit-tested from apps/extension/tests/scripts/check-compat.test.ts.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Paths relative to the repository root, which the caller supplies: the
 *  module is imported by tests as well as run as a script. */
const SCAN_DIR = "apps/extension/src";
const EXEMPT_DIR = join(SCAN_DIR, "migrations");

const COMPAT_TOKEN =
  /\blegacy\b|\bdeprecated\b|\bbackwards?[ -]compat|\bold (format|shape|schema|keys?)\b|\bmigrat(e|ed|ion|ions)\b/i;
const MIGRATIONS_IMPORT = /(["'])@\/migrations(?:\/[^"']*)?\1/g;
const IDENTIFIER = /[A-Za-z_$][\w$]*/g;
const EXPORTED_DECLARATION =
  /^export\s+(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

function* walk(dir: string, skip?: string): Generator<string> {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (path !== skip) yield* walk(path, skip);
    } else if (/\.tsx?$/.test(entry)) {
      yield path;
    }
  }
}

/** Every identifier a module under the folder declares with `export`: the
 *  API the rest of the extension is allowed to name. */
export function exemptIdentifiers(root: string): Set<string> {
  const names = new Set<string>();
  for (const file of walk(join(root, EXEMPT_DIR))) {
    for (const match of readFileSync(file, "utf8").matchAll(EXPORTED_DECLARATION)) {
      const name = match[1];
      if (name !== undefined) names.add(name);
    }
  }
  return names;
}

/** `legacySettings` -> `legacy Settings`, `old_shape` -> `old shape`,
 *  `XMLMigration` -> `XML Migration`: word boundaries where identifiers hide
 *  them. */
function splitWords(text: string): string {
  return text
    .replace(/_/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
}

/** The offending token in `line`, or null. */
export function compatToken(line: string, exempt: ReadonlySet<string>): string | null {
  const stripped = line
    .replace(MIGRATIONS_IMPORT, "")
    .replace(IDENTIFIER, (identifier) => (exempt.has(identifier) ? "" : identifier));
  const match = COMPAT_TOKEN.exec(splitWords(stripped));
  return match ? match[0] : null;
}

/** Hits as `path:line: token`, paths relative to `root`. */
export function scanTree(root: string): { scanned: number; hits: string[] } {
  const exempt = exemptIdentifiers(root);
  const hits: string[] = [];
  let scanned = 0;
  for (const file of walk(join(root, SCAN_DIR), join(root, EXEMPT_DIR))) {
    scanned++;
    readFileSync(file, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const token = compatToken(line, exempt);
        if (token) hits.push(`${relative(root, file)}:${index + 1}: ${token}`);
      });
  }
  return { scanned, hits };
}

function main(): void {
  const { scanned, hits } = scanTree(fileURLToPath(new URL("..", import.meta.url)));
  // A scan that found no source files is a broken scan root, not a clean tree.
  if (scanned === 0) {
    console.error(`x no TypeScript sources found under ${SCAN_DIR}`);
    process.exit(1);
  }
  if (hits.length > 0) {
    for (const hit of hits) console.error(`x ${hit}`);
    console.error(
      `\n${hits.length} compatibility token(s) outside ${EXEMPT_DIR}/ (move the code there)`,
    );
    process.exit(1);
  }
  console.log(`Compatibility-code placement check passed (${scanned} files).`);
}

// Under Vitest the module URL is not file:-scheme and argv[1] is the runner.
const entry = process.argv[1];
if (
  entry !== undefined &&
  import.meta.url.startsWith("file:") &&
  resolve(entry) === fileURLToPath(import.meta.url)
) {
  main();
}
