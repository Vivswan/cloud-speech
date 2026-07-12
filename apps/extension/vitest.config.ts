import { defineConfig } from "vitest/config";
import { WxtVitest } from "wxt/testing";

export default defineConfig({
  plugins: [WxtVitest()],
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
