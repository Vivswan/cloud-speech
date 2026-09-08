#!/usr/bin/env bun
// Sync assertions for files that TypeScript imports cannot reach: Markdown,
// GitHub templates, and package manifests that restate values whose single
// source is packages/constants. Assert-only, never rewrites: settings.yml is
// managed by repo-platform and the issue templates keep GitHub's own YAML
// style. Runs in `bun run check` (scripts/check.mjs). Runs under bun (not
// node) so it can import the shared TS constants; the scan itself is
// unit-tested from apps/extension/tests/scripts/check-sync.test.ts.

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

/** Every restatement under `root` checked against its constant: `inspected`
 *  counts the assertions run, findings describe the ones that did not hold. */
export function scanRepo(root: string): { inspected: number; findings: string[] } {
  const findings: string[] = [];
  let inspected = 0;

  /** Bytes of the file at `path` (relative to root), read once. A file that
   *  cannot be read is one finding and yields undefined so the assertions on
   *  it are skipped instead of aborting the scan and losing the findings so
   *  far. */
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

  /** Exact occurrence counts, so a location silently losing (or gaining) a
   *  restatement fails instead of passing vacuously off the remaining copies. */
  const assertCount = (path: string, needle: string, expected: number, what: string) => {
    inspected++;
    const text = readText(path);
    if (text === undefined) return;
    const found = countOccurrences(text, needle);
    if (found !== expected) {
      findings.push(`${path}: expected ${expected}x ${what} "${needle}", found ${found}`);
    }
  };

  /** Like assertCount, but scoped to the (first) section of the file matched
   *  by `sectionRe`, so a light/dark swap fails instead of passing on mere
   *  presence elsewhere in the file. */
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

  // --- Keyboard shortcuts: README shows the display renderings of SHORTCUTS
  // (the same derivation the website uses via shortcutDisplay).
  assertContains("README.md", shortcutDisplay(SHORTCUTS.readAloud), "read-aloud shortcut");
  assertContains("README.md", shortcutDisplay(SHORTCUTS.download), "download shortcut");

  // --- Site URL: every out-of-graph restatement must carry the production
  // URL from SITE_URL (links deeper into the site start with it). Counts pin
  // the known locations: README badge + intro + support; config.yml's setup
  // and troubleshooting contact links; bug_report.yml's troubleshooting link.
  assertCount("README.md", SITE_URL, 3, "site URL");
  assertCount(".github/ISSUE_TEMPLATE/config.yml", SITE_URL, 2, "site URL");
  assertCount(".github/ISSUE_TEMPLATE/bug_report.yml", SITE_URL, 1, "site URL");
  // The managed settings file pins the repo homepage to the site URL exactly.
  // (When repo-platform carries a central settings/repos/cloud-speech.yml, that
  // file wins over this one; this pins the in-repo fallback only.)
  assertContains(".github/settings.yml", `homepage: "${SITE_URL}"`, "homepage");
  // The web package description names the site (schemeless prose).
  assertContains(
    "apps/web/package.json",
    SITE_URL.replace(/^https:\/\//, "").replace(/\/$/, ""),
    "site host/path",
  );

  // --- Page-background pair: PAGE_BG_LIGHT/PAGE_BG_DARK reach the website
  // through TS imports (scripts/theme.ts), but the extension popup's pre-paint
  // <style> and the shared CSS tokens are plain CSS that cannot import them;
  // pin those literals here, each in its own light/dark scope so swapping the
  // pair fails. The popup's light rule is everything before its dark @media
  // block; the dark hex must appear ONLY inside that block.
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

  // tokens.css: the flipping --page pair lives once per theme block (the same
  // hexes legitimately recur as ink/text tokens, so pin the declarations, not
  // the raw hexes), and the fixed paper/ink constants once each.
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

  // --- Icon artwork: the extension's small icon drawing (the source of its
  // 16 and 32 px toolbar icons, see apps/extension/modules/icons.ts) and the
  // website's favicon are independent files with no build step deriving one
  // from the other; they must stay byte-identical.
  inspected++;
  const extensionIcon = read("apps/extension/src/assets/icon-16.svg");
  const webIcon = read("apps/web/public/icon-16.svg");
  if (extensionIcon !== undefined && webIcon !== undefined && !extensionIcon.equals(webIcon)) {
    findings.push(
      "apps/web/public/icon-16.svg differs from apps/extension/src/assets/icon-16.svg " +
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
