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
} from "@cloud-speech/constants";
import { runCheck } from "../lib/report.mts";

const countOccurrences = (text: string, needle: string) => text.split(needle).length - 1;

/** The tree under check, each file read once: an unreadable file is one finding, and the assertions
 *  that read it are skipped rather than aborting the scan. */
class RepoTree {
  /** Assertions run, file readable or not; zero fails the check. */
  inspected = 0;

  /** One line per drift, in assertion order. */
  readonly findings: string[] = [];

  /** Each file's bytes by root-relative path, or undefined once its read failed. */
  private readonly files = new Map<string, Buffer | undefined>();

  /** The repository root the paths are read under. */
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** The file's bytes, or undefined (and one finding, on the first read) when it cannot be read. */
  private read(path: string): Buffer | undefined {
    if (this.files.has(path)) return this.files.get(path);

    try {
      this.files.set(path, readFileSync(resolve(this.root, path)));
    } catch (error) {
      const code =
        error instanceof Error && "code" in error && typeof error.code === "string"
          ? error.code
          : String(error);
      this.findings.push(`${path}: cannot read (${code})`);
      this.files.set(path, undefined);
    }

    return this.files.get(path);
  }

  private text(path: string): string | undefined {
    return this.read(path)?.toString("utf8");
  }

  assertContains(path: string, needle: string, what: string): void {
    this.inspected++;
    const text = this.text(path);
    if (text !== undefined && !text.includes(needle)) {
      this.findings.push(
        `${path}: expected ${what} "${needle}" (constants drifted or the file did)`,
      );
    }
  }

  /** Exact counts, so a location silently losing (or gaining) a restatement fails instead of passing
   *  vacuously off the remaining copies. */
  assertCount(path: string, needle: string, expected: number, what: string): void {
    this.inspected++;
    const text = this.text(path);
    if (text === undefined) return;

    const found = countOccurrences(text, needle);
    if (found !== expected) {
      this.findings.push(`${path}: expected ${expected}x ${what} "${needle}", found ${found}`);
    }
  }

  /** Scoped to the first `sectionRe` match, so a light/dark swap fails instead of passing on presence
   *  elsewhere in the file. */
  assertCountIn(
    path: string,
    sectionRe: RegExp,
    needle: string,
    expected: number,
    what: string,
  ): void {
    this.inspected++;
    const text = this.text(path);
    if (text === undefined) return;

    const match = sectionRe.exec(text);
    if (!match) {
      this.findings.push(`${path}: could not find the ${what} section (${sectionRe})`);
      return;
    }

    const found = countOccurrences(match[0], needle);
    if (found !== expected) {
      this.findings.push(
        `${path}: expected ${expected}x ${what} "${needle}" in ${sectionRe}, found ${found}`,
      );
    }
  }

  /** Two files byte-identical; an unreadable one is already its own finding. */
  assertSameBytes(path: string, other: string, message: string): void {
    this.inspected++;
    const bytes = this.read(path);
    const otherBytes = this.read(other);
    if (bytes !== undefined && otherBytes !== undefined && !bytes.equals(otherBytes)) {
      this.findings.push(message);
    }
  }
}

/** README shows the same shortcutDisplay renderings the website does. */
function checkShortcuts(tree: RepoTree): void {
  tree.assertContains("README.md", shortcutDisplay(SHORTCUTS.readAloud), "read-aloud shortcut");
  tree.assertContains("README.md", shortcutDisplay(SHORTCUTS.download), "download shortcut");
}

/** Every restatement outside the import graph carries SITE_URL (deeper links start with it). The
 *  counts pin the known locations:
 *    README.md        3  badge, intro, support
 *    config.yml       2  setup and troubleshooting contact links
 *    bug_report.yml   1  troubleshooting link */
function checkSiteUrl(tree: RepoTree): void {
  tree.assertCount("README.md", SITE_URL, 3, "site URL");
  tree.assertCount(".github/ISSUE_TEMPLATE/config.yml", SITE_URL, 2, "site URL");
  tree.assertCount(".github/ISSUE_TEMPLATE/bug_report.yml", SITE_URL, 1, "site URL");

  // The repo-owned settings overlay pins the homepage; the sync renders it into
  // .github/settings.yml, which is the fleet's file.
  tree.assertContains(".github/settings.local.yml", `homepage: "${SITE_URL}"`, "homepage");

  // Schemeless, as prose in the package description.
  const host = SITE_URL.replace(/^https:\/\//, "").replace(/\/$/, "");
  tree.assertContains("apps/web/package.json", host, "site host/path");
}

/** The website imports PAGE_BG_LIGHT/PAGE_BG_DARK (inline/theme.ts), but the popup's pre-paint <style>
 *  is plain CSS, so its literals are pinned here, each in its own scope so swapping the pair fails.
 *    light scope  -> everything before the dark @media block; the dark hex must not appear there
 *    dark scope   -> the @media block to the end; the light hex must not appear there */
function checkPopupBackground(tree: RepoTree): void {
  const path = "apps/extension/src/entrypoints/popup/index.html";
  const lightScope = /^[\s\S]*?(?=@media \(prefers-color-scheme: dark\))/;
  const darkScope = /@media \(prefers-color-scheme: dark\)[\s\S]*$/;

  tree.assertCountIn(path, lightScope, `background: ${PAGE_BG_LIGHT};`, 1, "light page background");
  tree.assertCountIn(path, lightScope, PAGE_BG_DARK, 0, "dark hex outside the dark block");
  tree.assertCountIn(path, darkScope, `background: ${PAGE_BG_DARK};`, 1, "dark page background");
  tree.assertCountIn(path, darkScope, PAGE_BG_LIGHT, 0, "light hex inside the dark block");
}

/** The shared CSS tokens are plain CSS too, and the same hexes recur there as ink/text tokens, so the
 *  --page declarations are pinned, not the raw hexes. */
function checkTokens(tree: RepoTree): void {
  const path = "packages/ui-tokens/tokens.css";

  tree.assertCountIn(path, /:root \{[^}]*\}/, `--page: ${PAGE_BG_LIGHT};`, 1, "light --page token");
  tree.assertCountIn(path, /\.dark \{[^}]*\}/, `--page: ${PAGE_BG_DARK};`, 1, "dark --page token");
  tree.assertCount(path, "--page: #", 2, "--page declaration");
  tree.assertCount(path, `--color-paper: ${PAGE_BG_LIGHT};`, 1, "--color-paper token");
  tree.assertCount(path, `--color-ink: ${PAGE_BG_DARK};`, 1, "--color-ink token");
}

/** No build step derives the website favicon from the extension's auto-icons source; they must stay
 *  byte-identical. */
function checkIconArtwork(tree: RepoTree): void {
  tree.assertSameBytes(
    "apps/extension/src/assets/icon.svg",
    "apps/web/public/icon.svg",
    "apps/web/public/icon.svg differs from apps/extension/src/assets/icon.svg " +
      "(copy the updated one over the other)",
  );
}

export function scanRepo(root: string): { inspected: number; findings: string[] } {
  const tree = new RepoTree(root);
  checkShortcuts(tree);
  checkSiteUrl(tree);
  checkPopupBackground(tree);
  checkTokens(tree);
  checkIconArtwork(tree);
  return { inspected: tree.inspected, findings: tree.findings };
}

if (import.meta.main) {
  await runCheck({
    scan: () => scanRepo(fileURLToPath(new URL("../..", import.meta.url))),
    empty: "no constants sync assertions ran",
    failed: (count) => `${count} constants sync failure(s)`,
    passed: () => "Constants sync checks passed.",
  });
}
