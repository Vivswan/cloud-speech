#!/usr/bin/env bun
// Build assertion: the inline pre-paint theme script that Base.astro emits
// (serialized from src/scripts/theme.ts via Function.prototype.toString)
// must actually work as shipped. Serialization silently breaks if any of the
// serialized functions ever captures a module binding (the inlined copy then
// throws a ReferenceError in every visitor's browser), so this executes the
// script exactly as emitted in dist/index.html against stubbed browser
// globals and asserts the resolved theme for every storage state. Runs after
// `astro build` (see the build script in package.json).

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_BG_DARK, PAGE_BG_LIGHT } from "../../../packages/constants/src/index.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(webRoot, "dist/index.html"), "utf8");

// The theme init is the first attribute-less inline script in <head>,
// emitted by Astro exactly as "<script>...</script>". Plain string search:
// a tag regex here trips CodeQL's js/bad-tag-filter, and this only ever
// reads our own build output.
const open = html.indexOf("<script>");
const close = html.indexOf("</script>", open);
const script =
  open === -1 || close === -1 ? undefined : html.slice(open + "<script>".length, close);
if (!script?.includes("data-theme")) {
  console.error("check-theme-init: could not find the inline theme script in dist/index.html");
  process.exit(1);
}

/** Run the emitted script against stubbed globals; anything it references
 *  beyond localStorage/matchMedia/document throws a ReferenceError here
 *  (bun defines none of these), which is exactly the regression to catch. */
function run({ stored, storageThrows = false, systemDark }) {
  let dark = null;
  const documentElement = {
    attributes: {},
    classList: {
      toggle(name, force) {
        if (name === "dark") dark = force;
      },
    },
    setAttribute(name, value) {
      this.attributes[name] = value;
    },
  };
  const meta = {
    content: null,
    setAttribute(name, value) {
      if (name === "content") this.content = value;
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
  return { dark, theme: documentElement.attributes["data-theme"], metaColor: meta.content };
}

const cases = [
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
  let result;
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
