import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  // The Firefox suites run through playwright.firefox.config.ts.
  testIgnore: "firefox/**",
  timeout: 60_000,
  // The extension smoke drives ONE shared persistent browser context.
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["github"]] : "list",
});
