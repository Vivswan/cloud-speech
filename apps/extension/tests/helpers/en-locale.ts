import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateChromeMessages, parseMessagesText } from "@wxt-dev/i18n/build";

/** The shipped strings of one locale by their dotted keys, read with the same
 *  parser the build uses. The corpus has no plural entries. The parser prepends
 *  the browser's predefined messages; the generator's output, keyed the Chrome
 *  way, is what the build ships and so decides which entries count. */
export function loadLocale(locale: string): Record<string, string> {
  const text = readFileSync(resolve(__dirname, `../../src/locales/${locale}.yml`), "utf8");
  const parsed = parseMessagesText(text, "YAML");
  const shipped = generateChromeMessages(parsed);
  const entries = parsed.flatMap((message) =>
    message.type === "plural" || !(message.key.join("_") in shipped)
      ? []
      : [[message.key.join("."), message.message] as const],
  );
  return Object.fromEntries(entries);
}

/** Stand-in for `@/lib/text/i18n-runtime` resolving one shipped locale file, for tests that assert the sentences the user reads.
 *  A missing key throws, so a typo in the code under test fails instead of rendering an empty string. */
export function localeRuntime(locale: string) {
  const strings = loadLocale(locale);
  const tDynamic = (key: string, substitutions: string[] = []) => {
    const message = strings[key];
    if (message === undefined) throw new Error(`missing ${locale} string ${key}`);
    return message.replace(/\$(\d+)/g, (_, n: string) => substitutions[Number(n) - 1] ?? "");
  };
  return { tDynamic, i18n: { t: tDynamic } };
}

export function englishRuntime() {
  return localeRuntime("en");
}
