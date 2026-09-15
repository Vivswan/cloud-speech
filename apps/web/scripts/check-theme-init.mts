#!/usr/bin/env bun
// Runs the pre-paint theme script exactly as Base.astro emitted it into dist/index.html (after `astro build`).
// A captured module-only binding throws ReferenceError only when the executed branch reaches it, so the script runs through every case below.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_BG_DARK, PAGE_BG_LIGHT } from "../../../packages/constants/src/index.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(webRoot, "dist/index.html"), "utf8");

// The theme init is the first attribute-less <script> in <head>. A plain string search, not a regex: a tag
// regex trips CodeQL's js/bad-tag-filter, and this only reads our own build output.
function themeScript(page: string): string {
  const open = page.indexOf("<script>");
  const close = page.indexOf("</script>", open);
  const found =
    open === -1 || close === -1 ? undefined : page.slice(open + "<script>".length, close);
  if (found === undefined || !found.includes("data-theme")) {
    console.error("check-theme-init: could not find the inline theme script in dist/index.html");
    process.exit(1);
  }
  return found;
}
const script = themeScript(html);

interface RunInput {
  stored: string | null;
  storageThrows?: boolean;
  systemDark: boolean;
}

interface RunResult {
  dark: boolean | null;
  theme: string | undefined;
  metaColor: string | null;
}

/** new Function still resolves names against bun's own globals, so only a captured binding that neither the
 *  stubs nor bun define throws ReferenceError here, and only on the branch that reaches it. */
function run({ stored, storageThrows = false, systemDark }: RunInput): RunResult {
  let dark: boolean | null = null;
  const attributes: Record<string, string> = {};
  const documentElement = {
    classList: {
      toggle(name: string, force: boolean) {
        if (name === "dark") dark = force;
      },
    },
    setAttribute(name: string, value: string) {
      attributes[name] = value;
    },
  };
  let metaColor: string | null = null;
  const meta = {
    setAttribute(name: string, value: string) {
      if (name === "content") metaColor = value;
    },
  };
  const localStorage = {
    getItem() {
      if (storageThrows) throw new Error("storage denied");
      return stored;
    },
  };
  const matchMedia = () => ({ matches: systemDark });
  const document = { documentElement, querySelector: () => meta };
  new Function("localStorage", "matchMedia", "document", script)(
    localStorage,
    matchMedia,
    document,
  );
  return { dark, theme: attributes["data-theme"], metaColor };
}

interface Case {
  name: string;
  input: RunInput;
  dark: boolean;
  theme: string;
}

const cases: readonly Case[] = [
  { name: "stored dark", input: { stored: "dark", systemDark: false }, dark: true, theme: "dark" },
  {
    name: "stored light on a dark OS",
    input: { stored: "light", systemDark: true },
    dark: false,
    theme: "light",
  },
  {
    name: "no stored choice, dark OS",
    input: { stored: null, systemDark: true },
    dark: true,
    theme: "system",
  },
  {
    name: "no stored choice, light OS",
    input: { stored: null, systemDark: false },
    dark: false,
    theme: "system",
  },
  {
    name: "garbage stored value",
    input: { stored: "banana", systemDark: false },
    dark: false,
    theme: "system",
  },
  {
    name: "storage read denied, dark OS",
    input: { stored: null, storageThrows: true, systemDark: true },
    dark: true,
    theme: "system",
  },
];

let failures = 0;
for (const testCase of cases) {
  let result: RunResult;
  try {
    result = run(testCase.input);
  } catch (error) {
    console.error(`check-theme-init: ${testCase.name}: script threw: ${error}`);
    failures++;
    continue;
  }
  const wantColor = testCase.dark ? PAGE_BG_DARK : PAGE_BG_LIGHT;
  if (result.dark !== testCase.dark || result.theme !== testCase.theme) {
    console.error(
      `check-theme-init: ${testCase.name}: got dark=${result.dark} theme=${result.theme}, ` +
        `want dark=${testCase.dark} theme=${testCase.theme}`,
    );
    failures++;
  } else if (result.metaColor !== wantColor) {
    console.error(
      `check-theme-init: ${testCase.name}: theme-color ${result.metaColor}, want ${wantColor}`,
    );
    failures++;
  }
}

if (failures > 0) {
  console.error(`check-theme-init: ${failures} case(s) failed`);
  process.exit(1);
}
console.log(`check-theme-init: emitted pre-paint script passes all ${cases.length} cases`);
