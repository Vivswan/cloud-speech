# Contributing to cloud-speech

Thanks for contributing! This document covers the conventions every change
in this repository goes through.

CI, settings, and standards files here (including this document above the
marker at the bottom) are managed by
[Vivswan/repo-platform](https://github.com/vivswan/repo-platform);
local edits to managed files are replaced on the next template sync.

## Pull requests

- Changes land through pull requests and are squash-merged; the PR title
  becomes the commit subject on the default branch.
- The PR title and every pushed commit subject must be a
  [Conventional Commit](https://www.conventionalcommits.org/en/v1.0.0/),
  for example `feat: add X` or `fix(parser): handle Y`. Releases are
  versioned from these subjects.

## CI

- CI gates on a single status check, `all-green`, which needs every
  gating CI job (the convention is documented in
  [repo-platform's all-green guide](https://github.com/vivswan/repo-platform/blob/main/docs/all-green.md)).
- Repository-specific checks live in `.github/workflows/checks.yml`; run
  the commands it lists locally before pushing.
- A typography gate enforces plain ASCII punctuation: no curly quotes,
  em-dashes, or invisible unicode.

## Security

Never report vulnerabilities in issues or pull requests - see
[SECURITY.md](SECURITY.md) for the private reporting route.

## Code of conduct

Participation in this project is governed by the
[code of conduct](CODE_OF_CONDUCT.md).

<!-- Repository-specific contributing documentation (dev setup, build and
     test commands, review expectations) goes below this line. It survives
     template updates via three-way merge. -->

## Setup

```bash
git clone https://github.com/vivswan/cloud-speech
cd cloud-speech
bun install
bun run dev        # extension dev (browser opens) + website on localhost:5173
```

`bun run dev:extension` runs the extension alone with interactive WXT keys;
`bun run dev:web` runs only the website.

## Before you open a PR

All of these must pass (CI runs them via the repo-owned
`.github/workflows/checks.yml`):

```bash
bun run typecheck      # strict TypeScript, both apps
bun run check          # biome lint + format, YAML style (check:fix auto-fixes)
bun run test:coverage  # vitest unit tests with coverage thresholds
bun run test:firefox   # the same suite against the firefox build target
bun run build:chrome && bun run build:firefox  # both browser builds must succeed
bun run verify:zips    # manifest smoke on the emitted store zips
bun run build:web      # website build
bun run test:e2e       # Playwright popup smoke against the built extension
                       # (one-time: bunx playwright install chromium)
```

## Project layout

- `apps/extension`: the WXT extension (see `AGENTS.md` for architecture)
- `apps/web`: the website with setup guides, pricing, troubleshooting, and the
  privacy policy (Astro, GitHub Pages)
- `packages/constants`: shared identity constants (provider roster, store
  listing IDs, site/repo URLs) consumed by both apps
- `packages/ui-tokens`: shared UI theme tokens
- `sources/`: the original single-provider forks as read-only reference
  (gitignored; not part of a fresh checkout)

## Adding a TTS provider

All provider-specific logic lives in one file behind the `TtsProvider`
interface; the UI, storage, and playback are registry-driven. The roster
data around it is pinned by `apps/extension/tests/lib/roster-sync.test.ts`,
so a missed spot fails tests instead of drifting:

1. Create `apps/extension/src/providers/<id>.ts` implementing `TtsProvider`
   (see `types.ts`; `google.ts` is a good REST example, `polly.ts` an SDK one).
2. Register it with one line in `apps/extension/src/providers/index.ts`.
3. Add its id, display name, and brand color to `PROVIDER_IDS`,
   `PROVIDER_NAMES`, and `PROVIDER_COLORS` in `packages/constants`.
4. Add its strings to all four locales in `apps/extension/src/locales/`.
5. Wire up the website: a setup guide page at
   `apps/web/src/pages/setup/<id>.astro` plus its copies in every locale tree
   (`hi/`, `zh-cn/`, `zh-tw/`), the `--color-<id>` token in
   `apps/web/src/styles.css`, the provider entries in `apps/web/src/lib/`
   (`site.ts` metadata and blurb, `pricing.ts` rows), the localized pricing
   rows and homepage blurbs, all pinned by typecheck and the roster-sync
   tests.
6. Add the provider name to the dropdown in
   `.github/ISSUE_TEMPLATE/bug_report.yml`.
7. Add `buildSsml`/normalization tests under `apps/extension/tests/providers/`.

## Localization

Every user-facing string needs a key in `en.yml`, `hi.yml`, `zh_CN.yml`, and
`zh_TW.yml`. The locale tests enforce key and placeholder parity across all
four files; please keep them in sync rather than leaving English fallbacks.

## Releases (maintainers)

Merging the rolling release-please PR tags a version, builds the chrome and
firefox zips (plus the AMO-required sources zip) from the tag and attaches them
to the GitHub release, and publishes the single chrome zip to every Chrome Web
Store listing ID and the firefox zip to addons.mozilla.org (each skipped until
its secrets are configured); see `.github/workflows/release.yml`. The website
redeploys on the release via the managed `pages.yml` (production root from the
release tag; every push to main also publishes a preview under `/staging/`).
