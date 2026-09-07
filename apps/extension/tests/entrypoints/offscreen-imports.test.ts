import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Chrome's offscreen document may use only the runtime API: a module that
// defines a storage item runs `browser.storage` reads at import time and fails
// there. The document's import graph is walked statically so the class is
// caught at the source, whatever module gets added to the chain next.

const SRC = resolve(__dirname, "../../src");

function resolveImport(from: string, specifier: string): string | null {
  const base = specifier.startsWith("@/")
    ? resolve(SRC, specifier.slice(2))
    : specifier.startsWith(".")
      ? resolve(dirname(from), specifier)
      : null;
  if (base === null) return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, resolve(base, "index.ts")]) {
    if (existsSync(candidate) && !candidate.endsWith(SRC)) return candidate;
  }
  throw new Error(`${from} imports ${specifier}, which does not resolve`);
}

/** Value imports only: `import type` never runs the module. */
const IMPORT = /^import\s+(?!type\s)[^'"]*?from\s+["']([^"']+)["']|^import\s+["']([^"']+)["']/gm;

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(IMPORT)) {
      const target = resolveImport(file, match[1] ?? match[2] ?? "");
      if (target !== null) queue.push(target);
    }
  }
  return seen;
}

function touchesStorage(file: string): boolean {
  return /import\s*\{[^}]*\bstorage\b[^}]*\}\s*from\s*["']#imports["']/.test(
    readFileSync(file, "utf8"),
  );
}

describe("offscreen document imports", () => {
  it("reach no module that defines extension storage items", () => {
    const reachable = reachableFrom(resolve(SRC, "entrypoints/offscreen/main.ts"));
    const offenders = [...reachable].filter(touchesStorage).map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
    // The walk itself must see the document's real dependencies.
    expect([...reachable].map((f) => f.slice(SRC.length + 1))).toEqual(
      expect.arrayContaining(["lib/audio-session.ts", "lib/protocol.ts"]),
    );
  });
});
