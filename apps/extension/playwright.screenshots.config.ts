import { defineConfig } from "@playwright/test";

// Renders the store-listing screenshots (docs/store-listing.md, "Screenshots")
// through e2e/store-screenshots.ts. Its own config keeps the render out of the
// ordinary `test:e2e` run: the file is not a spec, so the default testMatch
// never picks it up, and only this config names it.

// The OpenAI provider calls api.openai.com from the extension's service
// worker; Playwright routes service worker requests only behind this flag.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS = "1";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "store-screenshots.ts",
  // One scene connects two providers and waits for a live read; the first
  // scene may also build the extension.
  timeout: 120_000,
  // The scenes share one browser profile and build on each other in order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
});
