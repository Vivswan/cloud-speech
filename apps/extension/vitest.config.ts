import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing";

// The suite runs once per browser target in CI: plain `vitest` covers chrome,
// `WXT_TEST_BROWSER=firefox` re-runs it with import.meta.env.FIREFOX = true so
// the firefox branches (audio host, UI) are exercised too.
const browser = process.env.WXT_TEST_BROWSER === "firefox" ? "firefox" : "chrome";

export default defineConfig({
  plugins: [WxtVitest({ browser, manifestVersion: 3 })],
  // WXT's globals plugin only takes effect in real builds; Vitest transforms
  // import.meta.env differently AND coerces defined values to strings — so
  // the falsy case must be an EMPTY string ("false" would be truthy). All
  // code tests these flags by truthiness, matching the real boolean defines;
  // tests/env.test.ts fails the suite if this wiring ever regresses.
  define: {
    "import.meta.env.BROWSER": JSON.stringify(browser),
    "import.meta.env.CHROME": browser === "chrome" ? "true" : "",
    "import.meta.env.FIREFOX": browser === "firefox" ? "true" : "",
  },
  test: {
    environment: "happy-dom",
    globals: true,
    passWithNoTests: true,
    exclude: ["**/node_modules/**", "sources/**", ".output/**", ".wxt/**", "e2e/**"],
    setupFiles: ["./tests/setup.ts"],
    coverage: {
      provider: "v8",
      // Coverage tracks the logic core; UI/entrypoints are exercised manually
      // and via component tests, not line coverage.
      include: ["src/lib/**/*.ts", "src/providers/**/*.ts"],
      thresholds: {
        lines: 60,
        functions: 60,
        branches: 60,
        statements: 60,
      },
    },
  },
});
