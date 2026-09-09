import { SITE_LOCALES } from "@cloud-speech/constants";
import { defineConfig } from "@playwright/test";

// Renders the store-listing screenshots (docs/store-listing.md, "Screenshots")
// through tests/e2e/store-screenshots.ts into .output/store-screenshots/<locale>,
// one project per language the extension ships, named after the store's
// language code (the set's directory). Its own config keeps the render out of
// the ordinary `test:e2e` run: the file is not a spec, so the default testMatch
// never picks it up, and only this config names it. The `screenshots:store`
// script builds the extension before this config runs; `--project=<locale>`
// renders one set.

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "store-screenshots.ts",
  projects: SITE_LOCALES.map((locale) => ({ name: locale.storeLocale })),
  // One scene connects two providers and waits for a live read.
  timeout: 120_000,
  // The scenes share one browser profile and build on each other in order,
  // and the sets render one after another.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
});
