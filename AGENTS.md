# AGENTS.md

Guidance for coding agents (Claude Code, codex, …) working in this repository.
`CLAUDE.md` is a symlink to this file.

## Project

**Cloud Speech** (`cloud-speech` — the primary name everywhere) is a
browser MV3 extension that turns selected web text into speech via multiple cloud TTS providers:
Amazon Polly, Azure Speech, Google Cloud TTS, and OpenAI — all fully visible and usable.
One Chrome build is published unchanged to three Chrome Web Store listing IDs (the unified
listing + the two legacy fork listings, kept updated for backwards compatibility), and a
Firefox build ships to addons.mozilla.org as "Cloud Speech".

**Monorepo (bun workspaces):**

- `apps/extension` — the WXT extension (the main app)
- `apps/web` — Astro static site (setup guides at `setup/<provider>/`, pricing,
  troubleshooting, privacy policy) → GitHub Pages at vivswan.github.io/cloud-speech
- `packages/constants` — cross-app identity constants (store listing IDs/names, site/repo
  URLs, provider roster) consumed by both apps; extract more shared code into `packages/*`
  only when a second consumer exists
- `sources/` — the two original single-provider forks as **read-only reference**; never edit,
  excluded from lint/tests/builds

## Tech stack

- **WXT** (Vite) for the extension — `srcDir: src`, entrypoints in `src/entrypoints/`;
  **Astro** SSG for the web app (pages in `src/pages/`, shared layout/components, port 5173)
- **Bun** workspaces · **React 19** + React Compiler (extension) · **TypeScript strict**
- **Tailwind CSS v4** (`@tailwindcss/vite`) · shadcn-style Radix components
  (`apps/extension/src/components/ui/`) · **Zustand** stores
- **`wxt/storage`** typed items · **`@wxt-dev/i18n`** (YAML locales in `src/locales/`) ·
  **`@wxt-dev/auto-icons`**
- **Vitest** + WXT `fakeBrowser` · **Biome** pinned in the root package.json (lint + format; config mirrors the
  user's conventions — naming rules, noFloatingPromises, strict) · **Zod**

## Commands (run from repo root)

```bash
bun run dev            # BOTH apps: WXT extension dev + web on localhost:5173
bun run dev:extension  # extension only (interactive WXT keys work here)
bun run dev:web        # website only
bun run build          # Chrome build → apps/extension/.output/chrome-mv3
bun run build:firefox  # Firefox MV3 build → apps/extension/.output/firefox-mv3
bun run build:all      # both browsers
bun run build:web      # website → apps/web/dist
bun run zip:all        # store zips: cloud-speech-<version>-<browser>.zip
                       # (firefox also emits an AMO sources zip)
bun run test           # vitest (coverage thresholds: apps/extension/vitest.config.ts)
bun run typecheck      # tsc strict, both apps
bun run check          # biome check (check:fix to auto-fix)
```

## Architecture (the one rule that matters)

**Everything provider-specific lives behind `TtsProvider`**
(`apps/extension/src/providers/types.ts`): credential schema, models, audio formats, limits,
voice normalization, SSML/prosody building, chunking + assembly, capability predicates
(`supportsPitch(voice, model)` etc.). Adding a provider = one new file in `src/providers/` +
one line in `src/providers/index.ts` + locale strings + a `setup/<id>/` guide page in apps/web.
**No provider-id switches anywhere else.** UI/background must only consume the registry
(`providerList`) and predicates. Every registered provider is fully visible and usable — there
is deliberately NO hidden/"coming soon" provider mechanism.

Other key modules (all under `apps/extension/src/`):

- `lib/storage.ts` — single Zod-validated `settings` object in `sync` OR `local` (user toggle,
  flag itself in `local`); `session:voices` cache. Never write raw storage keys.
- `lib/migrations.ts` — one-time migration from the legacy forks' flat keys (property-presence
  detection; non-destructive; idempotent). Never `storage.sync.clear()`.
- `lib/reconcile.ts` — `reconcileSettings()` repairs invalid selectedVoice/model/style/formats
  after migration, voice fetch, credential/enable changes, and selection.
- `lib/guide.ts` — website URLs; dev builds link to localhost:5173, prod to GitHub Pages.
- `entrypoints/background.ts` — message router + handlers; owns all provider calls and the
  playback transport. The popup never calls provider APIs directly.
- `entrypoints/offscreen/` — Chrome audio playback (MV3 service workers can't play audio);
  main channel + separate preview channel. `lib/audio-host.ts` is the seam: on Firefox there
  is no offscreen API, so the same audio session (`lib/audio-session.ts`) runs directly in
  the background event page.

## Conventions

- Locked UI: Classic look, **auto-width popup** (bounded 600–800px wide, height pinned to
  Chrome's 600px popup cap — bounds live in `entrypoints/popup/index.html`),
  accordion Settings, chips+search VoicePicker with ▶ preview and ★ favorites (no recents).
- Use `browser.*` from `#imports`, never `chrome.*`.
- i18n keys live in `apps/extension/src/locales/*.yml` (en, hi, zh_CN, zh_TW); every
  user-facing string needs all 4.
- Voice composite keys are `providerId:voiceId` — always split on the FIRST colon only.
- CI: `.github/workflows/ci.yml` gates on the single `all-green` aggregate; releases via
  release-please (conventional commits — `feat:`/`fix:` drive semver); website deploys via
  `deploy-web.yml`; repo settings in `.github/settings.yml`.
- Run a cross-model review (`/rubber-duck-review`, codex) before every commit; fix blocking
  findings first. No AI attribution lines in commits or PRs.
