import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { PROVIDER_IDS, PROVIDER_NAMES } from "@cloud-speech/constants";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// Guards the couplings that no compiler checks: files that must stay in sync
// with the shared provider roster (@cloud-speech/constants) but live outside
// the TypeScript graph — the GitHub issue form, the locale files, and the
// website's setup pages.

const repoRoot = resolve(__dirname, "../../../..");

function loadIssueForm() {
  const raw = readFileSync(resolve(repoRoot, ".github/ISSUE_TEMPLATE/bug_report.yml"), "utf8");
  return parse(raw) as { body: { id?: string; attributes?: { options?: string[] } }[] };
}

describe("provider roster sync", () => {
  it("bug_report.yml provider dropdown covers every provider name verbatim", () => {
    // GitHub only prefills a dropdown when the query value equals an option —
    // Feedback.tsx passes PROVIDER_NAMES values.
    const form = loadIssueForm();
    const options = form.body.find((f) => f.id === "provider")?.attributes?.options ?? [];
    for (const name of Object.values(PROVIDER_NAMES)) {
      expect(options).toContain(name);
    }
  });

  it("bug_report.yml listing dropdown covers every install source Feedback.tsx sends", () => {
    const form = loadIssueForm();
    const options = form.body.find((f) => f.id === "listing")?.attributes?.options ?? [];
    for (const source of ["Chrome Web Store", "Firefox Add-ons", "Built from source"]) {
      expect(options).toContain(source);
    }
  });

  it("every locale names every provider (en matching the canonical names)", () => {
    const localesDir = resolve(repoRoot, "apps/extension/src/locales");
    for (const file of readdirSync(localesDir)) {
      const locale = parse(readFileSync(resolve(localesDir, file), "utf8")) as {
        providers: Record<string, { name?: string }>;
      };
      for (const id of PROVIDER_IDS) {
        expect(locale.providers[id]?.name, `${file} providers.${id}.name`).toBeTruthy();
        if (file === "en.yml") {
          expect(locale.providers[id]?.name).toBe(PROVIDER_NAMES[id]);
        }
      }
    }
  });

  it("every provider has a setup guide page on the website", () => {
    const pages = readdirSync(resolve(repoRoot, "apps/web/src/pages/setup"));
    for (const id of PROVIDER_IDS) {
      expect(pages, `setup page for ${id}`).toContain(`${id}.astro`);
    }
  });
});
