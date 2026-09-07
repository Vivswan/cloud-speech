import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import ts from "typescript";
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

type ModuleLink = ts.ImportDeclaration | ts.ExportDeclaration;

/** The import and re-export statements that load a module at runtime. Under
 *  verbatimModuleSyntax only a statement-level `type` erases the whole load;
 *  a `type` on one specifier erases that binding and keeps the load. */
function moduleLinks(fileName: string, source: string): Array<[ModuleLink, string]> {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest);
  const links: Array<[ModuleLink, string]> = [];
  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword) continue;
      if (ts.isStringLiteral(statement.moduleSpecifier)) {
        links.push([statement, statement.moduleSpecifier.text]);
      }
    } else if (ts.isExportDeclaration(statement) && !statement.isTypeOnly) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        links.push([statement, statement.moduleSpecifier.text]);
      }
    }
  }
  return links;
}

function loadedSpecifiers(fileName: string, source: string): string[] {
  return moduleLinks(fileName, source).map(([, specifier]) => specifier);
}

function reachableFrom(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of loadedSpecifiers(file, readFileSync(file, "utf8"))) {
      const target = resolveImport(file, specifier);
      if (target !== null) queue.push(target);
    }
  }
  return seen;
}

/** The names a link binds from its module: the module's own export names
 *  (`{ a as b }` binds `a`), or `*` for a namespace. Type-only specifiers bind
 *  nothing at runtime. */
function boundNames(link: ModuleLink): string[] {
  if (ts.isImportDeclaration(link)) {
    const bindings = link.importClause?.namedBindings;
    if (bindings === undefined) return [];
    if (ts.isNamespaceImport(bindings)) return ["*"];
    return bindings.elements
      .filter((element) => !element.isTypeOnly)
      .map((element) => (element.propertyName ?? element.name).text);
  }
  const clause = link.exportClause;
  if (clause === undefined || ts.isNamespaceExport(clause)) return ["*"];
  return clause.elements
    .filter((element) => !element.isTypeOnly)
    .map((element) => (element.propertyName ?? element.name).text);
}

/** Whether a module binds the storage API itself, by import or by re-export. */
function touchesStorage(fileName: string, source: string): boolean {
  return moduleLinks(fileName, source).some(
    ([link, specifier]) =>
      specifier === "#imports" &&
      boundNames(link).some((name) => name === "storage" || name === "*"),
  );
}

describe("offscreen document imports", () => {
  it("reach no module that defines extension storage items", () => {
    const reachable = reachableFrom(resolve(SRC, "entrypoints/offscreen/main.ts"));
    const offenders = [...reachable]
      .filter((file) => touchesStorage(file, readFileSync(file, "utf8")))
      .map((f) => f.slice(SRC.length + 1));
    expect(offenders).toEqual([]);
    // The walk itself must see the document's real dependencies.
    expect([...reachable].map((f) => f.slice(SRC.length + 1))).toEqual(
      expect.arrayContaining(["lib/audio-session.ts", "lib/protocol.ts"]),
    );
  });

  it.each([
    { source: 'import { a } from "@/lib/a";', loads: ["@/lib/a"] },
    { source: 'import {\n  a,\n  b,\n} from "./a";', loads: ["./a"] },
    { source: 'import "@/lib/side-effect";', loads: ["@/lib/side-effect"] },
    { source: 'import { type X } from "@/lib/a";', loads: ["@/lib/a"] },
    { source: 'export { getSettings } from "@/lib/storage";', loads: ["@/lib/storage"] },
    {
      source: 'export { getSettings as "read-settings" } from "@/lib/storage";',
      loads: ["@/lib/storage"],
    },
    { source: 'export * from "@/lib/storage";', loads: ["@/lib/storage"] },
    { source: 'export * as api from "@/lib/storage";', loads: ["@/lib/storage"] },
    { source: 'export { storage } from "#imports";', loads: ["#imports"] },
    { source: 'import type { X } from "@/lib/storage";', loads: [] },
    { source: 'export type { X } from "@/lib/storage";', loads: [] },
    { source: 'export interface Options {\n  // loaded from "@/lib/storage"\n}', loads: [] },
    { source: 'export const from = 1\nconst s = from + 1 // from "x"', loads: [] },
    { source: 'const url = "https://x.test"; f(<a href="from">from</a>);', loads: [] },
  ])("the walk follows $source", ({ source, loads }) => {
    expect(loadedSpecifiers("module.tsx", source)).toEqual(loads);
  });

  it.each([
    { source: 'import { storage } from "#imports";', touches: true },
    { source: 'import { browser, storage } from "#imports";', touches: true },
    { source: 'import { storage as store } from "#imports";', touches: true },
    { source: 'import * as ext from "#imports";', touches: true },
    { source: 'export { storage } from "#imports";', touches: true },
    { source: 'export * from "#imports";', touches: true },
    { source: 'export * as api from "#imports";', touches: true },
    { source: 'import { browser } from "#imports";', touches: false },
    { source: 'import { browser as storage } from "#imports";', touches: false },
    { source: 'export { browser as storage } from "#imports";', touches: false },
    { source: 'import { type storage, browser } from "#imports";', touches: false },
    { source: 'import type { storage } from "#imports";', touches: false },
    { source: 'import { storage } from "./storage";', touches: false },
  ])("storage detection on $source", ({ source, touches }) => {
    expect(touchesStorage("module.ts", source)).toBe(touches);
  });
});
