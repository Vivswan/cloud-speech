import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  PAGE_BG_DARK,
  PAGE_BG_LIGHT,
  SHORTCUTS,
  SITE_URL,
  shortcutDisplay,
} from "@cloud-speech/constants";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scanRepo } from "../../../../../scripts/checks/check-sync.mts";

const ICON = '<svg xmlns="http://www.w3.org/2000/svg"><circle r="4" /></svg>\n';

/** Every restatement where the check expects it. */
const IN_SYNC: Record<string, string> = {
  "README.md": [
    `# Cloud Speech [site](${SITE_URL})`,
    `Press ${shortcutDisplay(SHORTCUTS.readAloud)} to read aloud, ${shortcutDisplay(SHORTCUTS.download)} to download.`,
    `Install from ${SITE_URL} and get support at ${SITE_URL}.`,
    "",
  ].join("\n"),
  ".github/ISSUE_TEMPLATE/config.yml": `contact_links:\n  - url: ${SITE_URL}\n  - url: ${SITE_URL}troubleshooting\n`,
  ".github/ISSUE_TEMPLATE/bug_report.yml": `body:\n  - type: markdown\n    attributes:\n      value: See ${SITE_URL}\n`,
  ".github/settings.local.yml": `repository:\n  homepage: "${SITE_URL}"\n`,
  "apps/web/package.json": JSON.stringify({
    description: `Website for ${SITE_URL.replace(/^https:\/\//, "").replace(/\/$/, "")}`,
  }),
  "apps/extension/src/entrypoints/popup/index.html": [
    "<style>",
    `  html { background: ${PAGE_BG_LIGHT}; }`,
    "  @media (prefers-color-scheme: dark) {",
    `    html { background: ${PAGE_BG_DARK}; }`,
    "  }",
    "</style>",
    "",
  ].join("\n"),
  "packages/ui-tokens/tokens.css": [
    `:root {\n  --page: ${PAGE_BG_LIGHT};\n}`,
    `.dark {\n  --page: ${PAGE_BG_DARK};\n}`,
    `@theme {\n  --color-paper: ${PAGE_BG_LIGHT};\n  --color-ink: ${PAGE_BG_DARK};\n}`,
    "",
  ].join("\n"),
  "apps/extension/src/assets/icon.svg": ICON,
  "apps/web/public/icon.svg": ICON,
};

describe("constants sync check", () => {
  let root: string;
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), text);
    }
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "check-sync-"));
    write(IN_SYNC);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("passes a tree that restates every constant where the check expects it", () => {
    expect(scanRepo(root).findings).toEqual([]);
  });

  // Every assertion in the scan trips here, so one silently dropped is a missing line, not a pass.
  it("reports every drifted, missing, swapped, and diverged file in one run", () => {
    rmSync(join(root, ".github/ISSUE_TEMPLATE/config.yml"));
    write({
      "README.md": `# Cloud Speech\n\nPress a key to read aloud.\n\n${SITE_URL}\n`,
      ".github/ISSUE_TEMPLATE/bug_report.yml":
        "body:\n  - type: markdown\n    attributes:\n      value: See the site\n",
      ".github/settings.local.yml": 'repository:\n  homepage: "https://example.com/"\n',
      "apps/web/package.json": JSON.stringify({ description: "Website" }),
      "apps/extension/src/entrypoints/popup/index.html": [
        "<style>",
        `  html { background: ${PAGE_BG_DARK}; }`,
        "  @media (prefers-color-scheme: dark) {",
        `    html { background: ${PAGE_BG_LIGHT}; }`,
        "  }",
        "</style>",
        "",
      ].join("\n"),
      "packages/ui-tokens/tokens.css": `:root {\n  --page: ${PAGE_BG_DARK};\n}\n`,
      "apps/web/public/icon.svg": `${ICON}\n`,
    });

    const popup = "apps/extension/src/entrypoints/popup/index.html";
    const lightScope = "/^[\\s\\S]*?(?=@media \\(prefers-color-scheme: dark\\))/";
    const darkScope = "/@media \\(prefers-color-scheme: dark\\)[\\s\\S]*$/";
    const host = SITE_URL.replace(/^https:\/\//, "").replace(/\/$/, "");
    expect(scanRepo(root).findings).toEqual([
      `README.md: expected read-aloud shortcut "${shortcutDisplay(SHORTCUTS.readAloud)}" (constants drifted or the file did)`,
      `README.md: expected download shortcut "${shortcutDisplay(SHORTCUTS.download)}" (constants drifted or the file did)`,
      `README.md: expected 3x site URL "${SITE_URL}", found 1`,
      ".github/ISSUE_TEMPLATE/config.yml: cannot read (ENOENT)",
      `.github/ISSUE_TEMPLATE/bug_report.yml: expected 1x site URL "${SITE_URL}", found 0`,
      `.github/settings.local.yml: expected homepage "homepage: "${SITE_URL}"" (constants drifted or the file did)`,
      `apps/web/package.json: expected site host/path "${host}" (constants drifted or the file did)`,
      `${popup}: expected 1x light page background "background: ${PAGE_BG_LIGHT};" in ${lightScope}, found 0`,
      `${popup}: expected 0x dark hex outside the dark block "${PAGE_BG_DARK}" in ${lightScope}, found 1`,
      `${popup}: expected 1x dark page background "background: ${PAGE_BG_DARK};" in ${darkScope}, found 0`,
      `${popup}: expected 0x light hex inside the dark block "${PAGE_BG_LIGHT}" in ${darkScope}, found 1`,
      `packages/ui-tokens/tokens.css: expected 1x light --page token "--page: ${PAGE_BG_LIGHT};" in /:root \\{[^}]*\\}/, found 0`,
      "packages/ui-tokens/tokens.css: could not find the dark --page token section (/\\.dark \\{[^}]*\\}/)",
      'packages/ui-tokens/tokens.css: expected 2x --page declaration "--page: #", found 1',
      `packages/ui-tokens/tokens.css: expected 1x --color-paper token "--color-paper: ${PAGE_BG_LIGHT};", found 0`,
      `packages/ui-tokens/tokens.css: expected 1x --color-ink token "--color-ink: ${PAGE_BG_DARK};", found 0`,
      "apps/web/public/icon.svg differs from apps/extension/src/assets/icon.svg " +
        "(copy the updated one over the other)",
    ]);
  });
});
