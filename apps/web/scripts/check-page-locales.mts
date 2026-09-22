#!/usr/bin/env bun
// Base.astro emits hreflang links to each locale's variant of a page and @astrojs/sitemap its alternates,
// so a page missing from one locale tree ships broken links. This is a script and not the integration's
// `serialize`: the integration catches a throwing serialize, logs it, and skips the sitemap without
// failing the build.

import { readdirSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SITE_LOCALES } from "@cloud-speech/constants";

const pagesDir = resolve(dirname(fileURLToPath(import.meta.url)), "../src/pages");

const routes = readdirSync(pagesDir, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".astro"))
  .map((entry) => relative(pagesDir, resolve(entry.parentPath, entry.name)))
  .filter((page) => page !== "404.astro");

/** English is unprefixed (astro.config.mts), so any route no prefix matches is its. */
const localeOf = (route: string) =>
  SITE_LOCALES.find((locale) => locale.prefix && route.startsWith(locale.prefix)) ??
  SITE_LOCALES[0];

const variants = new Map<string, Set<string>>();
for (const route of routes) {
  const locale = localeOf(route);
  const pagePath = route.slice(locale.prefix.length);
  variants.set(pagePath, (variants.get(pagePath) ?? new Set()).add(locale.code));
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
