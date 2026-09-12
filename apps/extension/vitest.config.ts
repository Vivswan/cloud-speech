import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing/vitest-plugin";

// CI runs the suite once per browser: plain `vitest` covers chrome, `WXT_TEST_BROWSER=firefox` re-runs
// it with import.meta.env.FIREFOX = true so the firefox branches (audio host, UI) are exercised too.
const browser = process.env.WXT_TEST_BROWSER === "firefox" ? "firefox" : "chrome";

export default defineConfig({
  plugins: [
    // `root` anchors the wxt.config.ts lookup here: knip evaluates this file from the repo root, where
    // WXT would otherwise search process.cwd() and find nothing.
    WxtVitest({ browser, manifestVersion: 3, root: dirname(fileURLToPath(import.meta.url)) }),
    // WXT defines the browser flags (import.meta.env.CHROME, .FIREFOX, ...) as real booleans that a
    // build replaces statically, but Vitest assigns `import.meta.env.*` defines to process.env as
    // strings, so an inactive flag would arrive as the truthy "false". Dropping the false flags leaves
    // them undefined, falsy like the real define; tests/env.test.ts fails the suite if this regresses.
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
      // The logic core only; UI and entrypoints are covered by component tests and by hand, not by
      // line coverage.
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
