# Cloud Speech

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/kdcbeehimalgmeoeajnflggejlemclnn.svg)](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn) [![GitHub Pages](https://img.shields.io/badge/website-cloud--speech-blue)](https://vivswan.github.io/cloud-speech/) [![License](https://img.shields.io/badge/license-source--available-blue)](LICENSE.md)

Turn highlighted text on any web page into natural speech with your own cloud TTS account: Amazon Polly, Azure Speech, Google Cloud TTS, OpenAI, or any OpenAI-compatible server, from one extension. Setup guides, pricing notes, and troubleshooting are on the [website](https://vivswan.github.io/cloud-speech/).

## Features

- Connect Amazon Polly, Azure Speech, Google Cloud TTS, OpenAI, and/or any OpenAI-compatible server with your own credentials; every voice appears in one searchable picker, tagged by provider
- Preview any voice before selecting it, and star your favorites
- Read aloud from the context menu, a keyboard shortcut (`Ctrl/Cmd+Shift+S`), or the popup sandbox, with playback controls and live speed adjustment
- Download any selection as an MP3 file (`Ctrl/Cmd+Shift+E`)
- Adjust speed, pitch, volume, and speaking style where the selected voice supports them
- Use the interface in English, Chinese (Simplified and Traditional), or Hindi
- Credentials stay in your browser (Chrome sync optional), and text is sent only to the provider you chose

## Store listings

One Chrome build goes to the Chrome Web Store and a separate Firefox build to addons.mozilla.org. [docs/store-listing.md](docs/store-listing.md) owns both listings: their IDs, their copy, and the Polly for Chrome rename.

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
bun run check:size     # size-limit budget on the built content script
bun run typecheck      # tsc --noEmit (strict, both apps)
bun run check          # biome lint + format, then the scripts/checks/ sync, compat, and bun-pin checks (check:fix auto-fixes)
bun run test           # every workspace with a test script: the extension's vitest on both build targets, the website's bun test
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
- Before opening a PR, run the block above. It runs what the `check` and e2e jobs of `.github/workflows/checks.yml` run, their runner setup aside; that workflow's screenshot render job and the fleet checks in `ci.yml` are not in the block.
- Account-wide conventions: the [contributing guide](https://github.com/Vivswan/.github/blob/main/CONTRIBUTING.md).

## Security

Report vulnerabilities privately through the repository's Security tab (Report a vulnerability), never in an issue; the [security policy](https://github.com/Vivswan/cloud-speech/security/policy) has the details. In scope, on either listing: credential leaks, text sent anywhere but the chosen provider, and injection through the content script or the selection read.

The privacy page (source: `apps/web/src/pages/privacy.astro`) owns what the extension stores and where text goes; [docs/store-listing.md](docs/store-listing.md) owns the permissions, hosts contacted, and network traffic.

## Support

- Bug reports and feature requests: [GitHub Issues](https://github.com/vivswan/cloud-speech/issues)
- Website: [vivswan.github.io/cloud-speech](https://vivswan.github.io/cloud-speech/)

## License

- Individual and Small Organization License 1.1.0; who may use it, and how, is the summary table in [LICENSE](LICENSE.md).
- Releases through v1.0.8 were published under the MIT License and remain available under it.
