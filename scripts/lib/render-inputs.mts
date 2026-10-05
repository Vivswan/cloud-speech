// The manifests and lockfile are render inputs too: a dependency bump redraws every icon without touching a source
// file, and a scripts entry names the render command itself.

export const RENDER_INPUTS: readonly string[] = [
  "apps/extension/src",
  "packages",
  "apps/extension/tests/e2e/store-screenshots.ts",
  "apps/extension/tests/e2e/store-screenshots-copy.ts",
  "apps/extension/tests/e2e/assertions.ts",
  "apps/extension/tests/e2e/fixtures.ts",
  "apps/extension/tests/e2e/playback-waits.ts",
  "apps/extension/tests/e2e/fake-provider",
  "apps/extension/playwright.screenshots.config.ts",
  "apps/extension/package.json",
  "apps/extension/wxt.config.ts",
  "apps/extension/dev-profile.ts",
  "apps/extension/tsconfig.json",
  "package.json",
  "bunfig.toml",
  "bun.lock",
  ".bun-version",
  "LICENSE.md",
];
