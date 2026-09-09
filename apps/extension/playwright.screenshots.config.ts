import { defineConfig } from "@playwright/test";

// Renders the store-listing screenshots (docs/store-listing.md, "Screenshots")
// through tests/e2e/store-screenshots.ts into .output/store-screenshots. Its own
// config keeps the render out of the ordinary `test:e2e` run: the file is not
// a spec, so the default testMatch never picks it up, and only this config
// names it. The `screenshots:store` script builds the extension before this
// config runs.

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "store-screenshots.ts",
  // One scene connects two providers and waits for a live read.
  timeout: 120_000,
  // The scenes share one browser profile and build on each other in order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
});
