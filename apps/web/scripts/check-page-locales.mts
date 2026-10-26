#!/usr/bin/env bun
// Base.astro emits hreflang links to each locale's variant of a page and @astrojs/sitemap its alternates,
// so a page missing from one locale tree ships broken links. This is a script and not the integration's
// `serialize`: the integration catches a throwing serialize, logs it, and skips the sitemap without
// failing the build.

import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_LOCALES } from "@cloud-speech/constants";
import { stripLocale } from "../src/i18n/locales.ts";

/** The Astro pages tree; each locale's pages sit under a top-level folder named for it, English at the root. */
const pagesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/pages");

/** Each page file as the pathname it builds to: setup/polly.astro -> /setup/polly/, index.astro -> /. */
const routes = readdirSync(pagesDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".astro"))
  .map((entry) => relative(pagesDir, resolve(entry.parentPath, entry.name)))
  .filter((page) => page !== "404.astro")
  .map((page) => `/${page.replace(/(^|\/)index\.astro$/, "$1").replace(/\.astro$/, "/")}`);

/** Each locale-stripped pathname to the locales that author it. */
const variants = new Map<string, Set<string>>();

for (const route of routes) {
  const { locale, pagePath } = stripLocale(route, "/");
  variants.set(pagePath, (variants.get(pagePath) ?? new Set()).add(locale));
}

const incomplete = [...variants]
  .filter(([, codes]) => codes.size !== SITE_LOCALES.length)
  .map(
    ([pagePath, codes]) =>
      `  ${pagePath}: missing ${SITE_LOCALES.filter((locale) => !codes.has(locale.code))
        .map((locale) => locale.code)
        .join(", ")}`,
  );
if (incomplete.length > 0) {
  console.error(
    `check-page-locales: ${incomplete.length} page(s) are not authored in every locale:\n${incomplete.join("\n")}`,
  );
  process.exit(1);
}
console.log(
  `check-page-locales: ${variants.size} pages, each in all ${SITE_LOCALES.length} locales`,
);
