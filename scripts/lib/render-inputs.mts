// Everything a store-screenshot render is made from, as repository-relative paths. One roster, two readers:
// scripts/dev.mts re-renders the local sets when one of these is newer than the last render, and
// scripts/render-inputs-changed.mts tells the pull-request check whether a PR touched one. A directory
// names its whole tree. bun.lock and the manifests are inputs too: an icon library bump redraws every icon
// without touching a source file, and a scripts entry names the render command itself.

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
