#!/usr/bin/env bun
// Runs the two pre-paint scripts (theme, first-visit locale detect) exactly as Base.astro emitted them into
// dist/index.html (after `astro build`). A captured module-only binding throws ReferenceError only when the
// executed branch reaches it, so each script runs through every case below.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PAGE_BG_DARK, PAGE_BG_LIGHT } from "@cloud-speech/constants";
import { siteBase } from "../src/lib/pages-tier.ts";
import { scriptLiteral } from "../src/scripts/inline-script.ts";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(resolve(webRoot, "dist/index.html"), "utf8");

// The pre-paint scripts are the attribute-less <script>s in <head>, told apart by a string only one of them
// carries. A plain string search, not a regex: a tag regex trips CodeQL's js/bad-tag-filter, and this only
// reads our own build output.
function extractInlineScript(page: string, marker: string): string {
  let open = page.indexOf("<script>");
  while (open !== -1) {
    const close = page.indexOf("</script>", open);
    if (close === -1) break;
    const found = page.slice(open + "<script>".length, close);
    if (found.includes(marker)) return found;
    open = page.indexOf("<script>", close);
  }
  console.error(`check-theme-init: no inline script containing "${marker}" in dist/index.html`);
  process.exit(1);
}
const script = extractInlineScript(html, "data-theme");
const localeScript = extractInlineScript(html, "preferred-locale");

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

interface LocaleRunInput {
  languages: string[];
  /** navigator.language, which the script falls back to when the list is empty. */
  language?: string;
  stored?: string | null;
  storageThrows?: boolean;
}

/** `null`: the script stayed on the English page. */
function runLocale({
  languages,
  language = "",
  stored = null,
  storageThrows = false,
}: LocaleRunInput): {
  redirect: string | null;
  stored: string | null;
} {
  let redirect: string | null = null;
  let written: string | null = null;
  const localStorage = {
    getItem() {
      if (storageThrows) throw new Error("storage denied");
      return stored;
    },
    setItem(_key: string, value: string) {
      written = value;
    },
  };
  const navigator = { languages, language };
  const location = {
    replace(url: string) {
      redirect = url;
    },
  };
  new Function("localStorage", "navigator", "location", localeScript)(
    localStorage,
    navigator,
    location,
  );
  return { redirect, stored: written };
}

interface LocaleCase {
  name: string;
  input: LocaleRunInput;
  /** The locale the English page redirects to, or null to stay. */
  pick: string | null;
}

// The decision is constants' matchSiteLocale over navigator.languages in order: lowercase, first rule wins,
// English before any other match means stay.
const localeCases: readonly LocaleCase[] = [
  { name: "Traditional Chinese first", input: { languages: ["zh-TW", "en"] }, pick: "zh-tw" },
  { name: "English first", input: { languages: ["en-US", "hi"] }, pick: null },
  { name: "unshipped language then Hindi", input: { languages: ["ja", "hi-IN"] }, pick: "hi" },
  { name: "upper-case tag", input: { languages: ["ZH-HANT-HK"] }, pick: "zh-tw" },
  { name: "bare zh is Simplified", input: { languages: ["zh"] }, pick: "zh-cn" },
  { name: "no shipped language", input: { languages: ["fr", "de"] }, pick: null },
  { name: "empty language list, no language", input: { languages: [] }, pick: null },
  {
    name: "empty language list, navigator.language set",
    input: { languages: [], language: "hi-IN" },
    pick: "hi",
  },
  { name: "stored preference", input: { languages: ["hi"], stored: "en" }, pick: null },
  { name: "storage read denied", input: { languages: ["hi"], storageThrows: true }, pick: null },
];

for (const testCase of localeCases) {
  let result: ReturnType<typeof runLocale>;
  try {
    result = runLocale(testCase.input);
  } catch (error) {
    console.error(`check-theme-init: locale ${testCase.name}: script threw: ${error}`);
    failures++;
    continue;
  }
  const want = testCase.pick === null ? null : `${siteBase}${testCase.pick}/`;
  if (result.redirect !== want || result.stored !== testCase.pick) {
    console.error(
      `check-theme-init: locale ${testCase.name}: got redirect=${result.redirect} stored=${result.stored}, ` +
        `want redirect=${want} stored=${testCase.pick}`,
    );
    failures++;
  }
}

// scriptLiteral feeds both emitted scripts: the literal must evaluate back to its value while carrying none of the
// bytes that would end a JavaScript line or the <script> element.
const hostile = { key: "a\u2028b\u2029c</script><!--" };
const literal = scriptLiteral(hostile);
const roundTrip: unknown = new Function(`return ${literal};`)();
if (/[\u2028\u2029<]/.test(literal) || JSON.stringify(roundTrip) !== JSON.stringify(hostile)) {
  console.error(`check-theme-init: scriptLiteral: unsafe or lossy literal ${literal}`);
  failures++;
}

if (failures > 0) {
  console.error(`check-theme-init: ${failures} case(s) failed`);
  process.exit(1);
}
console.log(
  `check-theme-init: emitted pre-paint scripts pass all ${cases.length} theme and ${localeCases.length} locale cases, and scriptLiteral its literal case`,
);
