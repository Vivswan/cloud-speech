import { appendFileSync, cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SHORTCUTS, SITE_URL, shortcutDisplay } from "../../../../packages/constants/src/index.ts";
import { scanRepo } from "../../../../scripts/check-sync.mts";

const ROOT = resolve(__dirname, "../../../..");

describe("constants sync check", () => {
  // The count pins the assertion list: one silently dropped is a lost pin.
  it("runs every restatement assertion and finds this repository clean", () => {
    expect(scanRepo(ROOT)).toEqual({ inspected: 17, findings: [] });
  });

  it("reports every drifted, missing, and diverged file in one run", () => {
    const fixture = mkdtempSync(join(tmpdir(), "check-sync-"));
    try {
      // config.yml is left out on purpose: the scan must survive an unreadable
      // file in the middle of the run.
      for (const path of [
        ".github/ISSUE_TEMPLATE/bug_report.yml",
        ".github/settings.local.yml",
        "apps/web/package.json",
        "apps/extension/src/entrypoints/popup/index.html",
        "packages/ui-tokens/tokens.css",
        "apps/extension/src/assets/icon.svg",
        "apps/web/public/icon.svg",
      ]) {
        mkdirSync(dirname(join(fixture, path)), { recursive: true });
        cpSync(join(ROOT, path), join(fixture, path));
      }
      writeFileSync(
        join(fixture, "README.md"),
        `# Cloud Speech\n\nPress ${shortcutDisplay(SHORTCUTS.readAloud)} to read aloud.\n\n${SITE_URL}\n`,
      );
      appendFileSync(join(fixture, "apps/web/public/icon.svg"), "\n");

      expect(scanRepo(fixture)).toEqual({
        inspected: 17,
        findings: [
          `README.md: expected download shortcut "${shortcutDisplay(SHORTCUTS.download)}" (constants drifted or the file did)`,
          `README.md: expected 3x site URL "${SITE_URL}", found 1`,
          ".github/ISSUE_TEMPLATE/config.yml: cannot read (ENOENT)",
          "apps/web/public/icon.svg differs from apps/extension/src/assets/icon.svg " +
            "(copy the updated one over the other)",
        ],
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
