import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "yaml";

/** The shipped English strings, flattened to their dotted keys. */
export function loadEnglish(): Record<string, string> {
  const en: Record<string, string> = {};
  const walk = (value: unknown, prefix: string) => {
    if (value === null || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (child !== null && typeof child === "object") walk(child, path);
      else en[path] = String(child);
    }
  };
  walk(parse(readFileSync(resolve(__dirname, "../../src/locales/en.yml"), "utf8")), "");
  return en;
}

/** A stand-in for `@/lib/i18n-runtime` that resolves the real en.yml with its
 *  `$n` substitutions filled in, for tests that assert the sentences the user
 *  reads rather than key names. A key missing from en.yml throws, so a typo
 *  in the code under test fails instead of rendering an empty string. */
export function englishRuntime() {
  const en = loadEnglish();
  const tDynamic = (key: string, substitutions: string[] = []) => {
    const message = en[key];
    if (message === undefined) throw new Error(`missing en string ${key}`);
    return message.replace(/\$(\d+)/g, (_, n: string) => substitutions[Number(n) - 1] ?? "");
  };
  return { tDynamic, i18n: { t: tDynamic } };
}
