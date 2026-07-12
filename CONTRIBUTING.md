# Contributing

Thanks for helping improve Cloud Speech for Chrome!

## Setup

```bash
git clone https://github.com/vivswan/cloud-speech-for-chrome
cd cloud-speech-for-chrome
bun install
bun run dev        # extension dev (browser opens) + website on localhost:5173
```

`bun run dev:extension` runs the extension alone with interactive WXT keys;
`bun run dev:web` runs only the website.

## Before you open a PR

All of these must pass; CI gates on them via the single `all-green` check:

```bash
bun run typecheck      # strict TypeScript, both apps
bun run check          # biome lint + format (check:fix auto-fixes)
bun run test:coverage  # vitest unit tests with coverage thresholds
bun run build:all      # all three store listings must build
```

PR titles must follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `chore:`, and so on). PRs are squash-merged, and the
title becomes the commit that drives release-please versioning. `feat!:` and
`fix!:` denote breaking changes.

## Project layout

- `apps/extension`: the WXT extension (see `AGENTS.md` for architecture)
- `apps/web`: the website with setup guides, pricing, troubleshooting, and the
  privacy policy (Astro, GitHub Pages)
- `sources/`: the original single-provider forks, kept as read-only reference

## Adding a TTS provider

The whole point of the architecture: a provider is one file.

1. Create `apps/extension/src/providers/<id>.ts` implementing `TtsProvider`
   (see `types.ts`; `google.ts` is a good REST example, `polly.ts` an SDK one).
2. Register it with one line in `apps/extension/src/providers/index.ts`.
3. Add its strings to all four locales in `apps/extension/src/locales/`.
4. Add a setup guide page at `apps/web/src/pages/setup/<id>.astro` (copy an
   existing one; Astro routes pages by file path, so there is nothing to
   register).
5. Add `buildSsml`/normalization tests under `apps/extension/tests/providers/`.

No provider-specific code goes anywhere else; the UI, storage, and playback
are registry-driven.

## Localization

Every user-facing string needs a key in `en.yml`, `hi.yml`, `zh_CN.yml`, and
`zh_TW.yml`. The build fails on missing keys in the default locale; please keep
the other three in sync rather than leaving English fallbacks.

## Releases (maintainers)

Merging the rolling release-please PR tags a version, attaches the three store
zips to the GitHub release, publishes to the Chrome Web Store (when CWS secrets
are configured), and deploys the website.
