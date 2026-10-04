import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Tailwind v4 compiles `outline-none` and `outline-hidden` to `--tw-outline-style: none`, and every
// `outline-<n>` or `outline-[<w>]` to `outline-style: var(--tw-outline-style)`, so an element that resets its outline
// and draws one under a variant ends up with no outline at all. The browser only shows its own ring
// on :focus-visible, which a `focus-visible:outline-*` rule overrides, so a recipe that draws an
// outline needs no reset (ui/button.tsx is the model). The build reports nothing; this does, per
// file, so it holds however a file assembles its classes (literals, constants, cva, cn).

const COMPONENTS_DIR = resolve(__dirname, "../../src/components");

const RESET = /(?<![\w-])(?:[\w\-[\]=]+:)*outline-(?:none|hidden)(?![\w-])/;
const DRAWN = /(?<![\w-])(?:[\w\-[\]=]+:)*outline-(?:\d+|\[[^\]]+\])(?![\w-])/;

function resetsAndDraws(source: string): boolean {
  return RESET.test(source) && DRAWN.test(source);
}

function tsxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsxFiles(path);
    return name.endsWith(".tsx") ? [path] : [];
  });
}

describe("outline recipes", () => {
  it("control: a reset beside a drawn outline is flagged wherever the two sit in the file", () => {
    expect(
      resetsAndDraws(
        'const BASE = cva(["outline-none"]); <a className="focus-visible:outline-2" />',
      ),
    ).toBe(true);
    expect(
      resetsAndDraws(
        '<a className="outline-hidden" /><b className="data-[highlighted]:outline-2" />',
      ),
    ).toBe(true);
    expect(resetsAndDraws('<a className="outline-none focus-visible:outline-[2px]" />')).toBe(true);
    expect(resetsAndDraws('<a className="outline-none" />')).toBe(false);
    expect(
      resetsAndDraws('<a className="focus-visible:outline-2 focus-visible:outline-strong" />'),
    ).toBe(false);
  });

  it("no component file both resets an outline and draws one", () => {
    const offenders = tsxFiles(COMPONENTS_DIR)
      .filter((file) => resetsAndDraws(readFileSync(file, "utf8")))
      .map((file) => relative(COMPONENTS_DIR, file));
    expect(offenders).toEqual([]);
  });
});
