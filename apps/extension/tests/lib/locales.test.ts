import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { providerList } from "@/providers";

// Every user-facing string ships in all four locales. This test fails the
// moment a key is added to one locale file but not the others — including
// placeholder drift ($1 present in one language, missing in another).

const LOCALES_DIR = resolve(__dirname, "../../src/locales");
const BASE_LOCALE = "en.yml";

/** Flatten nested YAML into dot-separated key paths. */
function flatten(value: unknown, prefix = ""): Map<string, string> {
  const keys = new Map<string, string>();
  if (value === null || typeof value !== "object") return keys;
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child !== null && typeof child === "object") {
      for (const [k, v] of flatten(child, path)) keys.set(k, v);
    } else {
      keys.set(path, String(child));
    }
  }
  return keys;
}

function placeholders(text: string): string[] {
  return (text.match(/\$\d+/g) ?? []).sort();
}

const localeFiles = readdirSync(LOCALES_DIR).filter((f) => f.endsWith(".yml"));
const flattened = new Map(
  localeFiles.map((file) => [
    file,
    flatten(parse(readFileSync(resolve(LOCALES_DIR, file), "utf8"))),
  ]),
);

describe("locale files", () => {
  it("include the four shipped locales", () => {
    expect(localeFiles.sort()).toEqual(["en.yml", "hi.yml", "zh_CN.yml", "zh_TW.yml"]);
  });

  const base = flattened.get(BASE_LOCALE);
  if (!base) throw new Error(`${BASE_LOCALE} missing`);

  for (const file of localeFiles.filter((f) => f !== BASE_LOCALE)) {
    const locale = flattened.get(file);
    if (!locale) throw new Error(`${file} missing`);

    it(`${file} has exactly the keys of ${BASE_LOCALE}`, () => {
      const missing = [...base.keys()].filter((k) => !locale.has(k));
      const extra = [...locale.keys()].filter((k) => !base.has(k));
      expect(missing, `keys missing from ${file}`).toEqual([]);
      expect(extra, `keys in ${file} that ${BASE_LOCALE} lacks`).toEqual([]);
    });

    it(`${file} keeps every $n placeholder from ${BASE_LOCALE}`, () => {
      const drift = [...base.entries()]
        .filter(([key, text]) => {
          const translated = locale.get(key);
          return (
            translated !== undefined &&
            placeholders(text).join(",") !== placeholders(translated).join(",")
          );
        })
        .map(([key]) => key);
      expect(drift, `placeholder mismatch in ${file}`).toEqual([]);
    });
  }

  it("has no empty values in any locale", () => {
    for (const [file, keys] of flattened) {
      const empty = [...keys.entries()].filter(([, v]) => v.trim() === "").map(([k]) => k);
      expect(empty, `empty strings in ${file}`).toEqual([]);
    }
  });

  // Registry-driven strings bypass the typed i18n.t (tDynamic casts), so the
  // compiler can't catch a missing key — this test does.
  it(`covers every dynamic label key from the provider registry in ${BASE_LOCALE}`, () => {
    const dynamicKeys = providerList.flatMap((provider) => [
      provider.labelKey,
      ...provider.credentialSchema.map((field) => field.labelKey),
      ...provider.models.flatMap((model) =>
        model.descriptionKey ? [model.labelKey, model.descriptionKey] : [model.labelKey],
      ),
    ]);
    const missing = [...new Set(dynamicKeys)].filter((key) => !base.has(key));
    expect(missing, `registry keys missing from ${BASE_LOCALE}`).toEqual([]);
  });
});
