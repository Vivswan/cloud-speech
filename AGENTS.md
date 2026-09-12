<!-- BEGIN REPO-PLATFORM MANAGED -->
# AGENTS.md

Guidance for AI coding agents working in this repository. `CLAUDE.md`, `.github/copilot-instructions.md`, and `.github/agents.md` are symlinks to this file, so edit only here.

Everything between the BEGIN and END markers is managed by Vivswan/repo-platform and replaced on every sync. This repository's own guidance goes below the END marker.

## Project

Cloud Speech: Turn highlighted text into natural speech with Amazon Polly, Azure, Google Cloud TTS, or OpenAI: one browser extension, your own keys.

## Conventions

- PR titles and commit subjects are Conventional Commits; with the release-please module they drive its versioning. PRs are squash-merged, so the PR title becomes the commit subject; with the pr-title module, its check validates the title.
- CI gates on the `all-green` check, required by the managed ruleset. Under `.github/workflows/`, this repository's test and lint jobs go in `checks.yml`, its green-gated work on main in `post-green.yml` (both repo-owned); `ci.yml` is managed.
- With the release-please module, a green push to main releases through the fleet's release pipeline; this repository's release steps go in the repo-owned `update-release.yml` and `update-release-pr.yml` hooks.
- Plain ASCII punctuation only: no curly quotes, em-dashes, or invisible unicode. The check-typography gate enforces it.

## Managed by repo-platform

- Files whose header says "managed by Vivswan/repo-platform" arrive via sync PRs from that repository. Do not edit them here; change them there.
- Repository settings are rendered into `.github/settings.yml` by Vivswan/repo-platform's sync from its fleet layers plus this repository's own `.github/settings.local.yml`. Edit that file, never the rendered one or the GitHub UI; the merge rules are in repo-platform's docs/settings.md.
- Repo-owned, never overwritten by sync: `checks.yml`, `post-green.yml`, `.gitleaks.toml`, `.gitignore` outside its managed region, `.typography-allow.local`, the release hooks, and the module starters (the release-please JSON files, the `.claude-plugin/` manifests, the nightly workflows).
- Module selection is the `modules` list in `.repo-platform.yml`; the next sync PR applies a change. The per-module contracts are in repo-platform's docs/new-repo.md.
- Fleet-wide conventions: repo-platform's docs/fleet-guidelines.md.

## Toolchain

- bun: `bun install`, `bun test`, `bun run <script>` (scripts in `package.json`)
- `.bun-version` is managed by sync; pin another version in a repo-owned workflow's version input, not in the dotfile.

## Repository-specific guidance

<!-- Add project-specific instructions below the END marker; they are this repository's own and survive every sync. -->
<!-- END REPO-PLATFORM MANAGED -->

### Purpose

- Cloud Speech reads selected web text aloud through the user's own TTS account: Amazon Polly, Azure Speech, Google Cloud TTS, OpenAI, or any OpenAI-compatible server. The roster is `apps/extension/src/providers/index.ts`.
- Every registered provider is fully visible and usable. There is deliberately no hidden or "coming soon" provider.
- One Chrome build ships to two Chrome Web Store listings (the renamed Polly listing and the original Azure listing) plus a Firefox build on addons.mozilla.org; ids in `packages/constants`.

### Hard rules

- Everything provider-specific lives behind `TtsProvider` (`apps/extension/src/providers/types.ts`). UI and background consume only the registry and its capability predicates; no provider-id switches outside `apps/extension/src/migrations/`. Adding a provider: `apps/extension/tests/lib/roster-sync.test.ts` names every spot.
- `apps/extension/src/migrations/` is the only home for compatibility code and its vocabulary; `scripts/check-compat.mts` holds the exact rule. Steps are keyed by the schema version they move away from. Never `storage.sync.clear()`.
- Settings are one validated blob (`apps/extension/src/lib/storage.ts`); no raw storage keys outside the startup conversion in `apps/extension/src/migrations/index.ts`. A newer build's blob is never downgraded.
- Use `browser.*` from `#imports`, never `chrome.*`.
- Superseded work never reaches the user as an error (`apps/extension/src/lib/slot.ts`).
- `sources/` holds the two original forks as read-only reference. Never edit it.

### Decisions kept on purpose

- Locked UI: Classic look, auto-width popup, accordion Settings, chips-and-search VoicePicker with preview and favorites, no recents.
- Every user-facing string exists in all four locales (`apps/extension/src/locales/`).
- Voice composite keys are `providerId:voiceId`; split on the first colon only.
- `packages/*` gains shared code only when a second consumer exists.

### Releases

- `always-bump-patch`: every release is a patch; a `Release-As: X.Y.Z` footer is the only way to move minor or major (`release-please-config.json`).
- Store publishing is the repo-owned `.github/workflows/update-release.yml`.

### Working here

- Cross-model review (`/rubber-duck-review`, codex) before every commit. No AI attribution in commits or PRs.
