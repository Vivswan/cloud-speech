<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by Vivswan/repo-platform and overwritten by template sync. This repository's own guidance goes below the END marker.

## Project

Cloud Speech: Turn highlighted text into natural speech with Amazon Polly, Azure, Google Cloud TTS, or OpenAI: one browser extension, your own keys.

## Toolchain

- bun: `bun install`, `bun test`, `bun run <script>` (scripts in `package.json`)
- `.bun-version` is managed by sync; pin another version in a repo-owned workflow's version input, not in the dotfile.

## Conventions

- PR titles and commit subjects are Conventional Commits; they drive release-please versioning. PRs are squash-merged, so the PR title becomes the commit subject. The `pr-title` check validates the title.
- CI gates on the `all-green` check, required by the managed ruleset. Under `.github/workflows/`, this repository's test and lint jobs go in `checks.yml`, its green-gated work on main in `post-green.yml` (both repo-owned); `ci.yml` is managed.
- A green push to main releases through the managed `release.yml`; this repository's release steps go in the repo-owned `update-release.yml` and `update-release-pr.yml` hooks.
- Plain ASCII punctuation only: no curly quotes, em-dashes, or invisible unicode. The check-typography gate enforces it.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform" arrive via sync PRs from that repository. Do not edit them here; change them there.
- Repository settings are applied from Vivswan/repo-platform's layers plus this repository's own `.github/settings.yml`. Edit that file, never the GitHub UI; the merge rules are in repo-platform's docs/settings.md.
- Repo-owned, never overwritten by sync: `checks.yml`, `post-green.yml`, `.gitleaks.toml`, `.gitignore` outside its managed region, `.typography-allow.local`, the release hooks and the release-please JSON files.
- Module selection is the `modules` list in `.repo-platform.yml`; the next sync PR applies a change. The per-module contracts are in repo-platform's docs/new-repo.md.
- Fleet-wide conventions: repo-platform's docs/fleet-guidelines.md.

## Repository-specific guidance

<!-- Add project-specific instructions below the END marker; they are this repository's own and survive template updates. -->
<!-- END REPO-PLATFORM MANAGED -->

### Project detail

**Cloud Speech** (`cloud-speech`, the primary name everywhere) is a browser MV3 extension that turns selected web text into speech via multiple cloud TTS providers: Amazon Polly, Azure Speech, Google Cloud TTS, and OpenAI, all fully visible and usable. One Chrome build is published to two Chrome Web Store listing IDs (Cloud Speech, the renamed Polly listing, plus the legacy Azure listing; both in `packages/constants`), and a Firefox build ships to addons.mozilla.org as "Cloud Speech".

**Monorepo (bun workspaces):**

- `apps/extension`: the WXT extension (the main app)
- `apps/web`: Astro static site (setup guides at `setup/<provider>/`, pricing, troubleshooting, privacy policy) → GitHub Pages at vivswan.github.io/cloud-speech (deployed by the managed `pages.yml`: production root from the latest release tag, a preview of main HEAD under `/staging/`)
- `packages/constants`: cross-app identity constants (store listing IDs/names, site/repo URLs, provider roster) consumed by both apps; extract more shared code into `packages/*` only when a second consumer exists
- `sources/`: the two original single-provider forks as **read-only reference**; never edit, gitignored and excluded from lint/tests/builds

### Tech stack

- **WXT** (Vite) for the extension, with entrypoints in `src/entrypoints/`; **Astro** SSG for the web app (pages in `src/pages/`, shared layout/components)
- **Bun** workspaces · **React 19** + React Compiler (extension) · **TypeScript strict**
- **Tailwind CSS v4** (`@tailwindcss/vite`) · shadcn-style Radix components (`apps/extension/src/components/ui/`)
- **`wxt/storage`** typed items (settings and playback state reach the popup as storage watches through `src/hooks/`; no Zustand) · **`@wxt-dev/i18n`** (YAML locales in `src/locales/`) · **`@wxt-dev/auto-icons`**
- **Vitest** + WXT `fakeBrowser` · **Biome** pinned in the root package.json (lint + format; config mirrors the user's conventions: naming rules, noFloatingPromises, strict) · **Zod**

### Architecture (the one rule that matters)

**Everything provider-specific lives behind `TtsProvider`** (`apps/extension/src/providers/types.ts`): credential schema, models, audio formats, limits, voice normalization, SSML/prosody building, chunking + assembly, capability predicates (`supportsPitch(voice, model)` etc.). Adding a provider = one new file in `src/providers/` + one line in `src/providers/index.ts` + locale strings + a `setup/<id>/` guide page in apps/web. **No provider-id switches anywhere else**, except the frozen historical schemas under `migrations/` (step `000000.ts` hardcodes the old forks' credential shapes). UI/background must only consume the registry (`providerList`) and predicates. Every registered provider is fully visible and usable; there is deliberately NO hidden/"coming soon" provider mechanism.

Other key modules (all under `apps/extension/src/`):

- `lib/storage.ts`: one Zod-validated `settings` blob carrying `schemaVersion`, in `sync` OR `local` (user toggle, flag itself in `local`). Never write raw storage keys. A settings edit never downgrades a blob a newer build wrote (`SettingsNewerError`); reads salvage its known fields instead.
- `migrations/`: the ONLY home for backwards-compatibility code. Steps are keyed by the schema version they migrate away from, files zero-padded like `000001.ts`; the settings handoff from the old fork listings lives under `migrations/handoff/`. Never `storage.sync.clear()`.
- `lib/reconcile.ts`: `reconcile()`/`reconcileSettings()` keep the atomic `selection` (voice + model + style) and prosody valid against the voice cache.
- `lib/protocol.ts`: the schema-first message registry, one route table per target; `Handlers<T>` makes a missing or extra handler a compile error. The content script uses the Zod-free `lib/protocol-content.ts`; `scripts/check-bundle-size.mjs` caps `content.js` after each build.
- `lib/playback.ts`: playback state is one document in `storage.session`; `claimPlayback()` is the only way its epoch advances and a stale `updatePlayback()` is a no-op. Audio bytes live in IndexedDB, never in the document. The popup watches the document (`usePlayback`); it never asks the background for state.
- `lib/slot.ts`: cancellation is an `AbortSignal` from a `Slot`/`SlotMap`. Superseded work must never surface to the user as an error (`isAbortError` tells it apart from a failure). Provider requests retry only transient provider failures (throttling, 5xx) through `lib/retry.ts`.
- `lib/guide.ts`: website URLs; environment-dependent base.
- `entrypoints/background.ts`: message router + handlers; owns all provider calls and the playback transport. The popup never calls provider APIs directly.
- `entrypoints/offscreen/` + `lib/audio-host.ts`: on Chrome the offscreen document plays audio and reports position events to the background, which owns the playback document; on Firefox the same audio session (`lib/audio-session.ts`) runs in the background event page. Offscreen code must not import storage (a test guards the import graph).

### Repository conventions

- Locked UI: Classic look, **auto-width popup**, accordion Settings, chips+search VoicePicker with ▶ preview and ★ favorites (no recents).
- Use `browser.*` from `#imports`, never `chrome.*`.
- i18n keys live in `apps/extension/src/locales/*.yml` (en, hi, zh_CN, zh_TW); every user-facing string needs all 4.
- Voice composite keys are `providerId:voiceId`; always split on the FIRST colon only.
- Compatibility vocabulary (legacy, deprecated, backward-compat, old format/shape/schema/keys, migrate/migration forms) lives only under `apps/extension/src/migrations/`; other extension source may import and call that folder's exports through `@/migrations`. `scripts/check-compat.mts` (in `bun run check`) scans `.ts`/`.tsx` under `apps/extension/src` and holds the exact token list.
- ASCII punctuation only (the check-typography action enforces it; repo-specific exemptions go in `.typography-allow.local`).
- YAML string values are always double-quoted, even when optional (enforced by `scripts/check-yaml.mjs` in `bun run check`; the managed ci.yml yamllint job lints general YAML style against `.yamllint`).
- Releases via release-please (conventional commits: `feat:`/`fix:` drive semver); the store publish pipeline (2 CWS listings + AMO) lives in `.github/workflows/update-release.yml`.
- Run a cross-model review (`/rubber-duck-review`, codex) before every commit; fix blocking findings first. No AI attribution lines in commits or PRs.
