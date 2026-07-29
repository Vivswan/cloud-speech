import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  EXTENSION_NAME,
  INSTALL_SOURCES,
  PROVIDER_COLORS,
  PROVIDER_IDS,
  PROVIDER_NAMES,
  type ProviderId,
  SITE_LOCALES,
} from "@cloud-speech/constants";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { providerList } from "@/providers";

// Guards the couplings that no compiler checks: files that must stay in sync
// with the shared constants (@cloud-speech/constants) but live outside the
// TypeScript graph: the GitHub issue form, the locale files, the website's
// page trees, and the website's CSS theme tokens.

const repoRoot = resolve(__dirname, "../../../..");

function loadIssueForm() {
  const raw = readFileSync(resolve(repoRoot, ".github/ISSUE_TEMPLATE/bug_report.yml"), "utf8");
  return parse(raw) as { body: { id?: string; attributes?: { options?: string[] } }[] };
}

describe("provider roster sync", () => {
  it("bug_report.yml provider dropdown covers every provider name verbatim", () => {
    // GitHub only prefills a dropdown when the query value equals an option;
    // Feedback.tsx passes PROVIDER_NAMES values.
    const form = loadIssueForm();
    const options = form.body.find((f) => f.id === "provider")?.attributes?.options ?? [];
    for (const name of Object.values(PROVIDER_NAMES)) {
      expect(options).toContain(name);
    }
  });

  it("bug_report.yml listing dropdown covers every install source Feedback.tsx sends", () => {
    // Feedback.tsx sends INSTALL_SOURCES values; same verbatim-match rule.
    // Set equality: a stale extra option in the form is drift too.
    const form = loadIssueForm();
    const options = form.body.find((f) => f.id === "listing")?.attributes?.options ?? [];
    expect([...options].sort()).toEqual(Object.values(INSTALL_SOURCES).sort());
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

  it("every locale's app.name is the canonical extension name", () => {
    // The name is a proper noun, never translated; the manifest name comes
    // from the same constant (verify-zips pins the shipped manifests).
    const localesDir = resolve(repoRoot, "apps/extension/src/locales");
    for (const file of readdirSync(localesDir)) {
      const locale = parse(readFileSync(resolve(localesDir, file), "utf8")) as {
        app: { name?: string };
      };
      expect(locale.app.name, `${file} app.name`).toBe(EXTENSION_NAME);
    }
  });

  it("styles.css provider color tokens match PROVIDER_COLORS", () => {
    // Tailwind v4 needs the @theme tokens as literal CSS (the bg-<id>
    // utilities are generated at build time), so the website restates the
    // hexes; this pins them to the shared constant.
    const css = readFileSync(resolve(repoRoot, "apps/web/src/styles.css"), "utf8");
    for (const id of PROVIDER_IDS) {
      const token = new RegExp(`--color-${id}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
      expect(token?.[1]?.toLowerCase(), `--color-${id} in styles.css`).toBe(
        PROVIDER_COLORS[id].toLowerCase(),
      );
    }
  });

  it("every provider has a setup guide page in every locale tree of the website", () => {
    // The Settings UI links guideUrl(`setup/<id>`) with the ACTIVE locale, so
    // a page missing from any tree is a live 404, not a cosmetic gap.
    // English is the unprefixed default tree; guide.ts mirrors the rest.
    for (const locale of SITE_LOCALES) {
      const tree = `${locale.prefix}setup`;
      const pages = readdirSync(resolve(repoRoot, "apps/web/src/pages", tree));
      for (const id of PROVIDER_IDS) {
        expect(pages, `${tree}/${id}.astro`).toContain(`${id}.astro`);
      }
    }
  });

  it("every non-default site locale has a mirrored page tree", () => {
    // guide.ts builds homepage/guide URLs for every SITE_LOCALES prefix, so a
    // missing tree is a live 404 for that language.
    for (const locale of SITE_LOCALES) {
      if (!locale.prefix) continue;
      const pages = readdirSync(resolve(repoRoot, "apps/web/src/pages", locale.prefix));
      expect(pages, `apps/web/src/pages/${locale.prefix}`).toContain("index.astro");
    }
  });

  it("website blurbs name every model family each provider module declares", () => {
    // The homepage cards' blurbs (lib/site.ts for English, the localized
    // index pages for the rest) restate the model rosters as prose; this pins
    // them to the provider modules so a roster change (like the Gemini
    // addition the google blurb once missed) fails here instead of drifting.
    // The map below is the explicit model-id -> display-family dictionary:
    // every declared model value MUST have an entry, so a new model forces a
    // decision; null means the blurb deliberately skips it.
    const blurbFamilies: Record<ProviderId, Record<string, string | null>> = {
      polly: {
        standard: "Standard",
        neural: "Neural",
        generative: "Generative",
        "long-form": "Long-form",
      },
      azure: {
        neural: "neural",
        // Retired legacy tier, kept only to classify old voice lists.
        standard: null,
      },
      google: {
        standard: "Standard",
        wavenet: "WaveNet",
        neural2: "Neural2",
        chirp: "Chirp",
        gemini: "Gemini",
      },
      openai: {
        "gpt-4o-mini-tts": "gpt-4o-mini-tts",
        "tts-1": "tts-1",
        "tts-1-hd": "tts-1-hd",
      },
      custom: {
        // Only the model credential field's default; the blurb describes
        // servers, not models.
        "tts-1": null,
      },
    };

    // Family names stay Latin in every translation with one exception:
    // the azure blurbs translate "neural" in the Chinese pages.
    const localizedFamilies: Record<string, Partial<Record<ProviderId, Record<string, string>>>> = {
      "pages/zh-cn/index.astro": { azure: { neural: "神经" } },
      "pages/zh-tw/index.astro": { azure: { neural: "神經" } },
    };

    // Token-boundary match so "tts-1" is not satisfied by "tts-1-hd" (a
    // family token ends where the [A-Za-z0-9-] run ends).
    const mentions = (text: string, family: string): boolean => {
      const escaped = family.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^A-Za-z0-9-])${escaped}(?=$|[^A-Za-z0-9-])`).test(text);
    };

    const blurbSources = [
      "lib/site.ts",
      "pages/hi/index.astro",
      "pages/zh-cn/index.astro",
      "pages/zh-tw/index.astro",
    ];
    for (const source of blurbSources) {
      const text = readFileSync(resolve(repoRoot, "apps/web/src", source), "utf8");
      for (const provider of providerList) {
        // The provider's blurb string (plain or template literal): inside its
        // providerMeta entry in site.ts, directly under its key in the
        // localized pages' `blurbs` records.
        const entry = source.endsWith(".ts")
          ? `${provider.id}:\\s*\\{[^]*?blurb:\\s*`
          : `${provider.id}:\\s*`;
        const blurb = new RegExp(`${entry}(?:"([^"]*)"|\`([^\`]*)\`)`).exec(text);
        const blurbText = blurb?.[1] ?? blurb?.[2];
        expect(blurbText, `${source} blurb for ${provider.id}`).toBeTruthy();
        for (const model of provider.models) {
          const family =
            localizedFamilies[source]?.[provider.id]?.[model.value] ??
            blurbFamilies[provider.id][model.value];
          expect(family, `blurbFamilies.${provider.id}["${model.value}"]`).not.toBeUndefined();
          if (family !== null && family !== undefined && blurbText) {
            expect(
              mentions(blurbText, family),
              `${source} ${provider.id} blurb mentions ${family}`,
            ).toBe(true);
          }
        }
      }
    }
  });
});
