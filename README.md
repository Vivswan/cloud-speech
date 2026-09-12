# Cloud Speech

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/kdcbeehimalgmeoeajnflggejlemclnn.svg)](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn) [![GitHub Pages](https://img.shields.io/badge/website-cloud--speech-blue)](https://vivswan.github.io/cloud-speech/) [![License](https://img.shields.io/badge/license-source--available-blue)](LICENSE.md)

Turn highlighted text on any web page into natural speech with your own cloud TTS account: Amazon Polly, Azure Speech, Google Cloud TTS, or OpenAI, from one extension. Setup guides, pricing notes, and troubleshooting are on the [website](https://vivswan.github.io/cloud-speech/).

## Features

- Connect Amazon Polly, Azure Speech, Google Cloud TTS, and/or OpenAI with your own credentials; every voice appears in one searchable picker, tagged by provider
- Preview any voice before selecting it, and star your favorites
- Read aloud from the context menu, a keyboard shortcut (`Ctrl/Cmd+Shift+S`), or the popup sandbox, with playback controls and live speed adjustment
- Download any selection as an MP3 file (`Ctrl/Cmd+Shift+E`)
- Adjust speed, pitch, volume, and speaking style where the selected voice supports them
- Use the interface in English, Chinese (Simplified and Traditional), or Hindi
- Credentials stay in your browser (Chrome sync optional), and text is sent only to the provider you chose

## Store listings

One Chrome build goes to two Chrome Web Store listings; a separate Firefox build goes to addons.mozilla.org.

| Listing | Store | Who gets it |
| --- | --- | --- |
| Cloud Speech (the Polly for Chrome listing, renamed in place) | Chrome Web Store | new installs; former Polly users received it as a normal update |
| Azure Speech for Chrome | Chrome Web Store | the same Chrome build; its users are prompted to move to Cloud Speech, settings transferred automatically |
| Cloud Speech | [addons.mozilla.org](https://addons.mozilla.org/) | the Firefox build |

## Development

- Stack: [WXT](https://wxt.dev), React 19, TypeScript (strict), Tailwind CSS v4, Bun workspaces.
- `apps/extension` is the extension; `apps/web` is the Astro website. The scripts below run from the repo root.

```bash
bun install            # install dependencies
bun run dev            # extension dev with HMR (opens Chrome) + website on localhost:5173
bun run dev:extension  # the extension alone, with interactive WXT keys
bun run dev:web        # the website alone
bun run build          # check + all builds: chrome, firefox, web (browser builds also zip)
bun run build:chrome   # Chrome build + store zip -> apps/extension/.output/chrome-mv3
bun run build:firefox  # Firefox build + store zip -> apps/extension/.output/firefox-mv3
bun run build:web      # website -> apps/web/dist
bun run typecheck      # tsc --noEmit (strict, both apps)
bun run check          # biome lint + format, YAML style (check:fix auto-fixes)
bun run test           # vitest, both build targets (chrome + firefox)
bun run test:coverage  # vitest with coverage thresholds
bun run lint:firefox   # Mozilla's addons-linter on the Firefox build
bun run verify:zips    # manifest smoke on the emitted store zips
bun run test:e2e       # Playwright popup smoke against the built extension (one-time: bunx playwright install chromium)
bun run test:e2e:firefox  # the same smoke in a stock Firefox through Selenium (needs a Firefox on PATH)
```

- Chrome: load `apps/extension/.output/chrome-mv3/` unpacked from `chrome://extensions` (Developer mode).
- Firefox: `bun run --cwd apps/extension dev:firefox` runs it in a temporary profile through web-ext.
- Architecture rules and the provider contract: [AGENTS.md](AGENTS.md).

Rebuilding the Firefox store package from source (AMO reviewers):

1. Install [Bun](https://bun.sh) at the version in `.bun-version`.
2. `bun install --frozen-lockfile`
3. `bun run --cwd apps/extension build:firefox`; the zip lands in `apps/extension/.output/`.

## Contributing

- PR titles are Conventional Commits; CI gates on the `all-green` check.
- Before opening a PR, run what `.github/workflows/checks.yml` runs, all from the block above.
- Account-wide conventions: the [contributing guide](https://github.com/Vivswan/.github/blob/main/CONTRIBUTING.md).

## Security

Report vulnerabilities privately through the repository's Security tab (Report a vulnerability), never in an issue; the [security policy](https://github.com/Vivswan/cloud-speech/security/policy) has the details. In scope:

- Every listing ships the same source at the same version, so a report against one applies to all.
- API credentials live in `chrome.storage` (`sync` by default, `local` when the sync toggle is off). Anything that exfiltrates, logs, or leaks them is high severity.
- Selected text goes only to the provider the user configured, straight from the browser, with no intermediary servers or analytics. Any other destination is a bug.
- The content script runs on all pages (`<all_urls>`) for error toasts; selected text is read on demand through `scripting.executeScript`. Injection or privilege escalation in either path is in scope.

## Support

- Bug reports and feature requests: [GitHub Issues](https://github.com/vivswan/cloud-speech/issues)
- Website: [vivswan.github.io/cloud-speech](https://vivswan.github.io/cloud-speech/)

## License

- Individual and Small Organization License 1.1.0; see [LICENSE](LICENSE.md) for the terms and its summary table.
- Individuals may use it for any purpose they choose for themselves; organizations under 100 people and 10,000,000 USD yearly income may use it; anything beyond that needs the licensor's permission.
- Releases through v1.0.8 were published under the MIT License and remain available under it.
