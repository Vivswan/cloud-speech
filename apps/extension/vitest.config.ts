import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

// The suite runs once per browser target in CI: plain `vitest` covers chrome,
// `WXT_TEST_BROWSER=firefox` re-runs it with import.meta.env.FIREFOX = true so
// the firefox branches (audio host, UI) are exercised too.
const browser = process.env.WXT_TEST_BROWSER === "firefox" ? "firefox" : "chrome";

export default defineConfig({
  plugins: [
    // `root` anchors wxt.config.ts lookup here: knip evaluates this file from the
    // repo root, where WXT would otherwise search process.cwd() and find nothing.
    WxtVitest({ browser, manifestVersion: 3, root: dirname(fileURLToPath(import.meta.url)) }),
    // WXT defines the browser flags (import.meta.env.CHROME, .FIREFOX, ...) as
    // real booleans, which a build replaces statically. Vitest instead assigns
    // `import.meta.env.*` defines to process.env at run time, where every value
    // is a string, so the inactive flags would arrive as the truthy "false"
    // and the source's `if (import.meta.env.FIREFOX)` branches would run in
    // the chrome suite. Dropping the false flags leaves them undefined, which
    // is falsy like the real define; tests/env.test.ts fails the suite if this
    // wiring ever regresses.
    {
      name: "cloud-speech:drop-false-env-flags",
      enforce: "post",
      config(config) {
        for (const [key, value] of Object.entries(config.define ?? {})) {
          if (key.startsWith("import.meta.env.") && value === "false") delete config.define?.[key];
        }
      },
    },
  ],
  test: {
    environment: "happy-dom",
    globals: true,
    passWithNoTests: true,
    exclude: ["**/node_modules/**", "sources/**", ".output/**", ".wxt/**", "tests/e2e/**"],
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
