import { defineConfig } from "@playwright/test";

// Playwright here is only the runner: the Firefox suites drive a stock
// Firefox through Selenium and geckodriver (e2e/firefox/fixtures.ts), since
// Playwright's own Firefox build cannot load extensions.
export default defineConfig({
  testDir: "./e2e/firefox",
  timeout: 60_000,
  // The smoke drives ONE shared browser session.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
});
