# AGENTS.md

This file provides guidance to AI coding agents working in this repository.
`CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are
symlinks to this file, so edit only here.

## Project

Cloud Speech: Turn highlighted text into natural speech with Amazon Polly, Azure, Google Cloud TTS, or OpenAI: one browser extension, your own keys.

## Toolchain

- Runtime and package manager: bun (`bun install`, `bun test`, `bun run <script>`)
- See `package.json` scripts for the available commands.

## Conventions

- PR titles and commit subjects must be Conventional Commits (`feat:`, `fix:`,
  `feat!:`, `chore:`, ...). PRs are squash-merged, so the PR title becomes the
  commit subject and drives release-please versioning. CI validates both
  (the ci.yml pr-title job + validate-commit-names).
- CI gates on a single required check named `all-green` in the managed
  `.github/workflows/ci.yml`. This repository's own test/lint jobs belong in
  `.github/workflows/checks.yml` (repo-owned, called inside the gate); do not
  edit ci.yml, template sync overwrites it. The `release` job runs on top
  of the gate (`needs: all-green`); the release pipeline is repo-owned in
  `.github/workflows/release.yml` (pre/post-release jobs go there, around the
  managed release-please machinery).
- No typographic look-alike characters (curly quotes, em-dashes, invisible
  unicode). CI enforces this with the check-typography action; use plain ASCII
  punctuation.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform"
  arrive via sync PRs pushed by that repository. Do not edit them here;
  change them in Vivswan/repo-platform and let the next sync
  PR deliver the update.
- Repository settings (description, topics, labels, rulesets, merge policy)
  are applied from Vivswan/repo-platform: by the
  `settings/repos/` file named after this repository over there when one
  exists, otherwise by this repository's own `.github/settings.yml`. Do not
  change settings by hand in the GitHub UI; edit the settings file.
- Repo-owned escape hatches stay local:
  `.github/workflows/checks.yml`,
  `.github/workflows/release.yml`, `.gitleaks.toml`,
  `.gitignore`'s marked LOCAL section, `.typography-allow.local`
  (typography exemptions; the managed `.typography-allow` is overwritten
  by sync), and the repository-specific section below.
- Module selection is this repository's own: edit the `modules` list in
  `.repo-platform.yml` and the next sync PR applies the change.

## Repository-specific guidance

<!-- Add project-specific instructions below. This section survives template
     updates via three-way merge. -->
<!-- repo-platform:local-section -->

### Project detail

**Cloud Speech** (`cloud-speech`, the primary name everywhere) is a
browser MV3 extension that turns selected web text into speech via multiple cloud TTS providers:
Amazon Polly, Azure Speech, Google Cloud TTS, and OpenAI, all fully visible and usable.
One Chrome build is published unchanged to three Chrome Web Store listing IDs (the unified
listing + the two legacy fork listings, kept updated for backwards compatibility), and a
Firefox build ships to addons.mozilla.org as "Cloud Speech".

**Monorepo (bun workspaces):**

- `apps/extension`: the WXT extension (the main app)
- `apps/web`: Astro static site (setup guides at `setup/<provider>/`, pricing,
  troubleshooting, privacy policy) → GitHub Pages at vivswan.github.io/cloud-speech
  (deployed by the managed `pages.yml`: production root from the latest release tag,
  a preview of main HEAD under `/staging/`)
- `packages/constants`: cross-app identity constants (store listing IDs/names, site/repo
  URLs, provider roster) consumed by both apps; extract more shared code into `packages/*`
  only when a second consumer exists
- `sources/`: the two original single-provider forks as **read-only reference**; never edit,
  gitignored and excluded from lint/tests/builds

### Tech stack

- **WXT** (Vite) for the extension, with `srcDir: src` and entrypoints in `src/entrypoints/`;
  **Astro** SSG for the web app (pages in `src/pages/`, shared layout/components, port 5173)
- **Bun** workspaces · **React 19** + React Compiler (extension) · **TypeScript strict**
- **Tailwind CSS v4** (`@tailwindcss/vite`) · shadcn-style Radix components
  (`apps/extension/src/components/ui/`) · **Zustand** stores
- **`wxt/storage`** typed items · **`@wxt-dev/i18n`** (YAML locales in `src/locales/`) ·
  **`@wxt-dev/auto-icons`**
- **Vitest** + WXT `fakeBrowser` · **Biome** pinned in the root package.json (lint + format; config mirrors the
  user's conventions: naming rules, noFloatingPromises, strict) · **Zod**

### Commands (run from repo root)

```bash
bun run dev            # BOTH apps: WXT extension dev + web on localhost:5173
bun run dev:extension  # extension only (interactive WXT keys work here)
bun run dev:web        # website only
bun run build          # check + ALL builds: chrome, firefox, web (each browser
                       # build also emits its store zip)
bun run build:chrome   # Chrome build + zip → apps/extension/.output/chrome-mv3,
                       # cloud-speech-<version>-chrome.zip
bun run build:firefox  # Firefox MV3 build + zip → apps/extension/.output/firefox-mv3
                       # (also emits the AMO sources zip)
bun run build:web      # website → apps/web/dist
bun run test           # vitest, chrome then firefox target (test:chrome /
                       # test:firefox run one; coverage: apps/extension/vitest.config.ts)
bun run typecheck      # tsc strict, both apps
bun run check          # biome check + YAML style (check:fix to auto-fix)
```

### Architecture (the one rule that matters)

**Everything provider-specific lives behind `TtsProvider`**
(`apps/extension/src/providers/types.ts`): credential schema, models, audio formats, limits,
voice normalization, SSML/prosody building, chunking + assembly, capability predicates
(`supportsPitch(voice, model)` etc.). Adding a provider = one new file in `src/providers/` +
one line in `src/providers/index.ts` + locale strings + a `setup/<id>/` guide page in apps/web.
**No provider-id switches anywhere else.** UI/background must only consume the registry
(`providerList`) and predicates. Every registered provider is fully visible and usable; there
is deliberately NO hidden/"coming soon" provider mechanism.

Other key modules (all under `apps/extension/src/`):

- `lib/storage.ts`: single Zod-validated `settings` object in `sync` OR `local` (user toggle,
  flag itself in `local`); `session:voices` cache. Never write raw storage keys.
- `lib/migrations.ts`: one-time migration from the legacy forks' flat keys (property-presence
  detection; non-destructive; idempotent). Never `storage.sync.clear()`.
- `lib/reconcile.ts`: `reconcileSettings()` repairs invalid selectedVoice/model/style/formats
  after migration, voice fetch, credential/enable changes, and selection.
- `lib/guide.ts`: website URLs; dev builds link to localhost:5173, prod to GitHub Pages.
- `entrypoints/background.ts`: message router + handlers; owns all provider calls and the
  playback transport. The popup never calls provider APIs directly.
- `entrypoints/offscreen/`: Chrome audio playback (MV3 service workers can't play audio);
  main channel + separate preview channel. `lib/audio-host.ts` is the seam: on Firefox there
  is no offscreen API, so the same audio session (`lib/audio-session.ts`) runs directly in
  the background event page.

### Repository conventions

- Locked UI: Classic look, **auto-width popup** (bounded 600-800px wide, height pinned to
  Chrome's 600px popup cap; bounds live in `entrypoints/popup/index.html`),
  accordion Settings, chips+search VoicePicker with ▶ preview and ★ favorites (no recents).
- Use `browser.*` from `#imports`, never `chrome.*`.
- i18n keys live in `apps/extension/src/locales/*.yml` (en, hi, zh_CN, zh_TW); every
  user-facing string needs all 4.
- Voice composite keys are `providerId:voiceId`; always split on the FIRST colon only.
- ASCII punctuation only (see Conventions above; the check-typography action reuses
  VS Code's ambiguous/invisible-character data). CJK sentence punctuation
  (U+3001 U+3002 and corner brackets) is allowed in files containing CJK text,
  Devanagari in files containing Devanagari; the full-width comma U+FF0C is
  banned everywhere - use ", " (comma + space). Repo-specific path exemptions
  go in `.typography-allow.local`.
- YAML string values are always double-quoted, even when optional (enforced by
  `scripts/check-yaml.mjs`, bun-native, runs in `bun run check`; workflow
  files under `.github/` and the machine-written `.copier-answers.yml` are
  exempt, and the managed ci.yml yamllint job lints general YAML style
  against `.yamllint`).
- Releases via release-please (conventional commits: `feat:`/`fix:` drive semver); the
  store publish pipeline (3 CWS listings + AMO) lives in `.github/workflows/release.yml`.
- Run a cross-model review (`/rubber-duck-review`, codex) before every commit; fix blocking
  findings first. No AI attribution lines in commits or PRs.
