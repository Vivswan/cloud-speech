#!/usr/bin/env bun
// Sync assertions for files TypeScript imports cannot reach (Markdown, GitHub templates, package
// manifests) that restate values whose single source is packages/constants. Assert-only, never
// rewrites: the settings overlay is read by the fleet's sync and the issue templates keep GitHub's
// own YAML style.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PAGE_BG_DARK,
  PAGE_BG_LIGHT,
  SHORTCUTS,
  SITE_URL,
  shortcutDisplay,
} from "../packages/constants/src/index.ts";
import { runCheck } from "./lib/report.mts";

const countOccurrences = (text: string, needle: string) => text.split(needle).length - 1;

export function scanRepo(root: string): { inspected: number; findings: string[] } {
  const findings: string[] = [];
  let inspected = 0;

  /** An unreadable file is one finding, and its assertions are skipped rather than aborting the scan. */
  const files = new Map<string, Buffer | undefined>();
  const read = (path: string): Buffer | undefined => {
    if (!files.has(path)) {
      try {
        files.set(path, readFileSync(resolve(root, path)));
      } catch (error) {
        const code =
          error instanceof Error && "code" in error && typeof error.code === "string"
            ? error.code
            : String(error);
        findings.push(`${path}: cannot read (${code})`);
        files.set(path, undefined);
      }
    }
    return files.get(path);
  };
  const readText = (path: string) => read(path)?.toString("utf8");

  const assertContains = (path: string, needle: string, what: string) => {
    inspected++;
    const text = readText(path);
    if (text !== undefined && !text.includes(needle)) {
      findings.push(`${path}: expected ${what} "${needle}" (constants drifted or the file did)`);
    }
  };

  /** Exact counts, so a location silently losing (or gaining) a restatement fails instead of passing
   *  vacuously off the remaining copies. */
  const assertCount = (path: string, needle: string, expected: number, what: string) => {
    inspected++;
    const text = readText(path);
    if (text === undefined) return;
    const found = countOccurrences(text, needle);
    if (found !== expected) {
      findings.push(`${path}: expected ${expected}x ${what} "${needle}", found ${found}`);
    }
  };

  /** Scoped to the first `sectionRe` match, so a light/dark swap fails instead of passing on presence
   *  elsewhere in the file. */
  const assertCountIn = (
    path: string,
    sectionRe: RegExp,
    needle: string,
    expected: number,
    what: string,
  ) => {
    inspected++;
    const text = readText(path);
    if (text === undefined) return;
    const match = sectionRe.exec(text);
    if (!match) {
      findings.push(`${path}: could not find the ${what} section (${sectionRe})`);
      return;
    }
    const found = countOccurrences(match[0], needle);
    if (found !== expected) {
      findings.push(
        `${path}: expected ${expected}x ${what} "${needle}" in ${sectionRe}, found ${found}`,
      );
    }
  };

  // --- Keyboard shortcuts: README shows the same shortcutDisplay renderings the website does.
  assertContains("README.md", shortcutDisplay(SHORTCUTS.readAloud), "read-aloud shortcut");
  assertContains("README.md", shortcutDisplay(SHORTCUTS.download), "download shortcut");

  // --- Site URL: every restatement outside the import graph carries SITE_URL (deeper links start
  // with it). The counts pin the known locations:
  //   README.md        3  badge, intro, support
  //   config.yml       2  setup and troubleshooting contact links
  //   bug_report.yml   1  troubleshooting link
  assertCount("README.md", SITE_URL, 3, "site URL");
  assertCount(".github/ISSUE_TEMPLATE/config.yml", SITE_URL, 2, "site URL");
  assertCount(".github/ISSUE_TEMPLATE/bug_report.yml", SITE_URL, 1, "site URL");
  // The repo-owned settings overlay pins the homepage; the sync renders it into
  // .github/settings.yml, which is the fleet's file.
  assertContains(".github/settings.local.yml", `homepage: "${SITE_URL}"`, "homepage");
  // Schemeless, as prose in the package description.
  assertContains(
    "apps/web/package.json",
    SITE_URL.replace(/^https:\/\//, "").replace(/\/$/, ""),
    "site host/path",
  );

  // --- Page-background pair: the website imports PAGE_BG_LIGHT/PAGE_BG_DARK (scripts/theme.ts), but
  // the popup's pre-paint <style> and the shared CSS tokens are plain CSS, so their literals are pinned
  // here, each in its own light/dark scope so swapping the pair fails.
  //   popup light scope  -> everything before the dark @media block; the dark hex must not appear there
  //   popup dark scope   -> the @media block to the end; the light hex must not appear there
  const popupPath = "apps/extension/src/entrypoints/popup/index.html";
  assertCountIn(
    popupPath,
    /^[\s\S]*?(?=@media \(prefers-color-scheme: dark\))/,
    `background: ${PAGE_BG_LIGHT};`,
    1,
    "light page background",
  );
  assertCountIn(
    popupPath,
    /^[\s\S]*?(?=@media \(prefers-color-scheme: dark\))/,
    PAGE_BG_DARK,
    0,
    "dark hex outside the dark block",
  );
  assertCountIn(
    popupPath,
    /@media \(prefers-color-scheme: dark\)[\s\S]*$/,
    `background: ${PAGE_BG_DARK};`,
    1,
    "dark page background",
  );
  assertCountIn(
    popupPath,
    /@media \(prefers-color-scheme: dark\)[\s\S]*$/,
    PAGE_BG_LIGHT,
    0,
    "light hex inside the dark block",
  );

  // tokens.css: the same hexes recur as ink/text tokens, so the --page declarations are pinned, not the
  // raw hexes.
  const tokensPath = "packages/ui-tokens/tokens.css";
  assertCountIn(
    tokensPath,
    /:root \{[^}]*\}/,
    `--page: ${PAGE_BG_LIGHT};`,
    1,
    "light --page token",
  );
  assertCountIn(tokensPath, /\.dark \{[^}]*\}/, `--page: ${PAGE_BG_DARK};`, 1, "dark --page token");
  assertCount(tokensPath, "--page: #", 2, "--page declaration");
  assertCount(tokensPath, `--color-paper: ${PAGE_BG_LIGHT};`, 1, "--color-paper token");
  assertCount(tokensPath, `--color-ink: ${PAGE_BG_DARK};`, 1, "--color-ink token");

  // --- Icon artwork: no build step derives the website favicon from the extension's auto-icons source;
  // they must stay byte-identical.
  inspected++;
  const extensionIcon = read("apps/extension/src/assets/icon.svg");
  const webIcon = read("apps/web/public/icon.svg");
  if (extensionIcon !== undefined && webIcon !== undefined && !extensionIcon.equals(webIcon)) {
    findings.push(
      "apps/web/public/icon.svg differs from apps/extension/src/assets/icon.svg " +
        "(copy the updated one over the other)",
    );
  }

  return { inspected, findings };
}

runCheck(import.meta.url, {
  scan: () => scanRepo(fileURLToPath(new URL("..", import.meta.url))),
  empty: "no constants sync assertions ran",
  failed: (count) => `${count} constants sync failure(s)`,
  passed: () => "Constants sync checks passed.",
});
