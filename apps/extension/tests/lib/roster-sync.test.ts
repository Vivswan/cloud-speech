import { existsSync, readdirSync, readFileSync } from "node:fs";
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
import { providerList, providers } from "@/providers";
import type { TtsProvider } from "@/providers/types";

// Couplings no compiler checks: files that must stay in sync with @cloud-speech/constants but live outside the
// TypeScript graph (the GitHub issue form, the locale files, the website's page trees and CSS theme tokens).

const repoRoot = resolve(__dirname, "../../../..");

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// `id` as a top-level object key in biome-formatted source (two-space indent), bare or quoted (`polly: {`, `"eleven-labs": {`),
// never a key that merely starts with it (`openai_legacy:`).
function objectKey(id: string): RegExp {
  const escaped = escapeRegExp(id);
  return new RegExp(`^  (?:"${escaped}"|'${escaped}'|${escaped})\\s*:`, "m");
}

function loadIssueForm() {
  const raw = readFileSync(resolve(repoRoot, ".github/ISSUE_TEMPLATE/bug_report.yml"), "utf8");
  return parse(raw) as { body: { id?: string; attributes?: { options?: string[] } }[] };
}

describe("provider roster sync", () => {
  it("bug_report.yml listing dropdown covers every install source Feedback.tsx sends", () => {
    // Feedback.tsx sends INSTALL_SOURCES values; same verbatim-match rule.
    // Set equality: a stale extra option in the form is drift too.
    const form = loadIssueForm();
    const options = form.body.find((f) => f.id === "listing")?.attributes?.options ?? [];
    expect([...options].sort()).toEqual(Object.values(INSTALL_SOURCES).sort());
  });

  it("the English locale names every provider by its canonical name", () => {
    // Presence in every locale is the new-provider checklist's job below; this pins the en values to PROVIDER_NAMES.
    const locale = parse(
      readFileSync(resolve(repoRoot, "apps/extension/src/locales/en.yml"), "utf8"),
    ) as { providers: Record<string, { name?: string }> };
    for (const id of PROVIDER_IDS) {
      expect(locale.providers[id]?.name, `en.yml providers.${id}.name`).toBe(PROVIDER_NAMES[id]);
    }
  });

  it("every locale's app.name is the canonical extension name", () => {
    // The name is a proper noun, never translated; the manifest name comes from the same constant (verify-zips pins the shipped manifests).
    const localesDir = resolve(repoRoot, "apps/extension/src/locales");
    for (const file of readdirSync(localesDir)) {
      const locale = parse(readFileSync(resolve(localesDir, file), "utf8")) as {
        app: { name?: string };
      };
      expect(locale.app.name, `${file} app.name`).toBe(EXTENSION_NAME);
    }
  });

  it("styles.css provider color tokens match PROVIDER_COLORS", () => {
    // Tailwind v4 needs the @theme tokens as literal CSS (the bg-<id> utilities are generated at build time), so the
    // website restates the hexes; this pins them to the shared constant.
    const css = readFileSync(resolve(repoRoot, "apps/web/src/styles.css"), "utf8");
    for (const id of PROVIDER_IDS) {
      const token = new RegExp(`--color-${escapeRegExp(id)}:\\s*(#[0-9a-fA-F]{6})\\s*;`).exec(css);
      expect(token?.[1]?.toLowerCase(), `--color-${id} in styles.css`).toBe(
        PROVIDER_COLORS[id].toLowerCase(),
      );
    }
  });

  it("every non-default site locale has a mirrored page tree", () => {
    // guide.ts builds homepage/guide URLs for every SITE_LOCALES prefix, so a missing tree is a live 404 for that language.
    for (const locale of SITE_LOCALES) {
      if (!locale.prefix) continue;
      const pages = readdirSync(resolve(repoRoot, "apps/web/src/pages", locale.prefix));
      expect(pages, `apps/web/src/pages/${locale.prefix}`).toContain("index.astro");
    }
  });

  it("website blurbs name every model family each provider module declares", () => {
    // The homepage blurbs (lib/site.ts for English, the localized index pages for the rest) restate the model rosters as prose,
    // so a roster change must fail here instead of drifting (the google blurb once missed Gemini).
    //   every declared model value -> an entry below, so a new model forces a decision
    //   null                       -> the blurb deliberately skips that model
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
        chirp: "Chirp HD",
        chirp3: "Chirp 3 HD",
        gemini: "Gemini",
      },
      openai: {
        "gpt-4o-mini-tts": "gpt-4o-mini-tts",
        "tts-1": "tts-1",
        "tts-1-hd": "tts-1-hd",
      },
      custom: {
        // Only the model credential field's default; the blurb describes servers, not models.
        "tts-1": null,
      },
    };

    // Family names stay Latin in every translation with one exception: the azure blurbs translate "neural" in the Chinese pages.
    const localizedFamilies: Record<string, Partial<Record<ProviderId, Record<string, string>>>> = {
      "pages/zh-cn/index.astro": { azure: { neural: "神经" } },
      "pages/zh-tw/index.astro": { azure: { neural: "神經" } },
    };

    // Token-boundary match so "tts-1" is not satisfied by "tts-1-hd" (a family token ends where the [A-Za-z0-9-] run ends).
    const mentions = (text: string, family: string): boolean =>
      new RegExp(`(^|[^A-Za-z0-9-])${escapeRegExp(family)}(?=$|[^A-Za-z0-9-])`).test(text);

    const blurbSources = [
      "lib/site.ts",
      "pages/hi/index.astro",
      "pages/zh-cn/index.astro",
      "pages/zh-tw/index.astro",
    ];
    for (const source of blurbSources) {
      const text = readFileSync(resolve(repoRoot, "apps/web/src", source), "utf8");
      for (const provider of providerList) {
        // The provider's blurb string (plain or template literal): inside its providerMeta entry in site.ts,
        // directly under its key in the localized pages' `blurbs` records.
        const key = objectKey(provider.id).source;
        const entry = source.endsWith(".ts") ? `${key}\\s*\\{[^]*?blurb:\\s*` : `${key}\\s*`;
        const blurb = new RegExp(`${entry}(?:"([^"]*)"|\`([^\`]*)\`)`, "m").exec(text);
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

function lookup(data: unknown, dottedKey: string): unknown {
  return dottedKey
    .split(".")
    .reduce<unknown>(
      (node, key) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined,
      data,
    );
}

describe("new provider checklist", () => {
  // Soft assertions, so ONE run lists everything a newly added PROVIDER_IDS entry still lacks, each line naming the file and the id.
  const missing = (file: string, what: string, id: string) => `${file}: ${what} missing "${id}"`;

  it("every provider id is present on every surface", () => {
    const constants = "packages/constants/src/index.ts";
    const issueForm = ".github/ISSUE_TEMPLATE/bug_report.yml";
    const siteFile = "apps/web/src/lib/site.ts";
    const pricingFile = "apps/web/src/lib/pricing.ts";
    const cssFile = "apps/web/src/styles.css";
    // GitHub only prefills the dropdown when the query value equals an option verbatim; Feedback.tsx sends PROVIDER_NAMES values.
    const providerOptions =
      loadIssueForm().body.find((f) => f.id === "provider")?.attributes?.options ?? [];
    const siteTs = readFileSync(resolve(repoRoot, siteFile), "utf8");
    const [pricingBlock, freeTierBlock = ""] = readFileSync(
      resolve(repoRoot, pricingFile),
      "utf8",
    ).split("export const freeTier");
    const css = readFileSync(resolve(repoRoot, cssFile), "utf8");
    const localesDir = resolve(repoRoot, "apps/extension/src/locales");
    const locales = readdirSync(localesDir).map((file) => ({
      file: `apps/extension/src/locales/${file}`,
      data: parse(readFileSync(resolve(localesDir, file), "utf8")) as unknown,
    }));

    for (const id of PROVIDER_IDS) {
      expect.soft(PROVIDER_NAMES[id], missing(constants, "PROVIDER_NAMES", id)).toBeTruthy();
      expect
        .soft(PROVIDER_COLORS[id] ?? "", missing(constants, "PROVIDER_COLORS", id))
        .toMatch(/^#[0-9a-f]{6}$/i);

      // The registry is typed Record<ProviderId, TtsProvider>, so at runtime a freshly added id has no entry until its module exists.
      const provider: TtsProvider | undefined = providers[id];
      expect
        .soft(provider?.id, missing("apps/extension/src/providers/index.ts", "registry entry", id))
        .toBe(id);

      for (const { file, data } of locales) {
        expect
          .soft(lookup(data, `providers.${id}.name`), missing(file, `providers.${id}.name`, id))
          .toBeTruthy();
        for (const model of provider?.models ?? []) {
          expect.soft(lookup(data, model.labelKey), missing(file, model.labelKey, id)).toBeTruthy();
        }
      }

      // The Settings UI links guideUrl(`setup/<id>`) with the ACTIVE locale, so a page missing from any tree is a live 404.
      for (const locale of SITE_LOCALES) {
        const page = `apps/web/src/pages/${locale.prefix}setup/${id}.astro`;
        expect
          .soft(existsSync(resolve(repoRoot, page)), missing(page, "setup guide", id))
          .toBe(true);
      }

      expect.soft(siteTs, missing(siteFile, "providerMeta entry", id)).toMatch(objectKey(id));
      expect.soft(pricingBlock, missing(pricingFile, "pricing entry", id)).toMatch(objectKey(id));
      expect.soft(freeTierBlock, missing(pricingFile, "freeTier entry", id)).toMatch(objectKey(id));
      expect
        .soft(providerOptions, missing(issueForm, "provider dropdown option", id))
        .toContain(PROVIDER_NAMES[id]);
      expect.soft(css, missing(cssFile, `--color-${id} token`, id)).toContain(`--color-${id}:`);
    }
  });
});

describe("objectKey", () => {
  it.each([
    ["  polly: {", "polly", true],
    ["  eleven-labs: {", "eleven-labs", true],
    ['  "eleven-labs": {', "eleven-labs", true],
    ["  'eleven-labs': {", "eleven-labs", true],
    ["  polly : {", "polly", true],
    ['  polly: { kind: "none" },', "polly", true],
    ["  openai_legacy: {", "openai", false],
    ["  openai-tts: {", "openai", false],
    ['  "openai-tts": {', "openai", false],
    ["    openai: {", "openai", false],
    ["  name: openai,", "openai", false],
    // Escaped: the dot is literal, not any-character.
    ["  axb: {", "a.b", false],
  ])("%j is a top-level %j key: %s", (source, id, matches) => {
    expect(objectKey(id).test(source)).toBe(matches);
  });
});
