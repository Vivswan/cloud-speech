# Cloud Speech

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/kdcbeehimalgmeoeajnflggejlemclnn.svg)](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn)
[![GitHub Pages](https://img.shields.io/badge/website-cloud--speech-blue)](https://vivswan.github.io/cloud-speech/)
[![GitHub](https://img.shields.io/github/license/vivswan/cloud-speech)](LICENSE)

Turn highlighted text on any web page into natural speech using multiple cloud text-to-speech
providers (Amazon Polly, Azure Speech, Google Cloud TTS, and OpenAI) from a single extension.
Setup guides, pricing notes, and troubleshooting live on the
[website](https://vivswan.github.io/cloud-speech/).

## Features

- Connect Amazon Polly, Azure Speech, Google Cloud TTS, and/or OpenAI with your own
  credentials; every voice appears in one searchable picker, tagged by provider
- Preview any voice before selecting it, and star your favorites
- Read aloud from the context menu, a keyboard shortcut (`Ctrl/Cmd+Shift+S`), or the popup
  sandbox, with playback controls and live speed adjustment
- Download any selection as an MP3 file (`Ctrl/Cmd+Shift+E`)
- Adjust speed, pitch, volume, and speaking style where the selected voice supports them
- Use the interface in English, Chinese (Simplified and Traditional), or Hindi
- Credentials stay in your browser (Chrome sync optional), and text is sent only to the
  provider you chose

## Store listings

One Chrome build is published to three Chrome Web Store listing IDs, so users of the original
single-provider extensions keep receiving updates:

- Cloud Speech: the unified listing, recommended for new users
- The original Polly and Azure listings receive the same build in place; their users are
  prompted to move to the unified listing with their settings transferred automatically

A Firefox build ships to [addons.mozilla.org](https://addons.mozilla.org/) as "Cloud Speech".

## Development

Built with [WXT](https://wxt.dev), React 19, TypeScript (strict), Tailwind CSS v4, and Bun.
The repo is a bun-workspaces monorepo: `apps/extension` holds the extension, `apps/web` the
Astro website (setup guides, pricing, troubleshooting, privacy policy).

```bash
bun install            # install dependencies
bun run dev            # extension dev with HMR (opens Chrome) + website on localhost:5173
bun run build          # check + all builds: chrome, firefox, web (browser builds also zip)
bun run build:chrome   # Chrome build + store zip → apps/extension/.output/chrome-mv3
bun run build:firefox  # Firefox build + store zip → apps/extension/.output/firefox-mv3
bun run build:web      # website → apps/web/dist
bun run test           # vitest, both build targets (chrome + firefox)
bun run check          # biome lint + format
bun run typecheck      # tsc --noEmit (strict, both apps)
```

Load an unpacked build from `apps/extension/.output/chrome-mv3/` via `chrome://extensions`
(Developer mode). For Firefox, `bun run --cwd apps/extension dev:firefox` runs the extension
in a temporary profile via web-ext.

To rebuild the Firefox store package from source (for example as an AMO reviewer): install
[Bun](https://bun.sh) (the version pinned in the root package.json `packageManager`
field), then run `bun install --frozen-lockfile` followed by
`bun run --cwd apps/extension build:firefox`. The zip appears in `apps/extension/.output/`.

### Architecture in one paragraph

Provider-specific logic (SDK calls, credential fields, voice normalization, SSML/prosody) lives
entirely behind the `TtsProvider` interface in `apps/extension/src/providers/`, one file per
provider plus a registry. Everything else (playback transport, offscreen audio, storage, UI) is
provider-agnostic and registry-driven. Adding a new TTS API = one new provider file + one
registry line + locale strings + a setup guide page on the website.

## Support

- Bug reports and feature requests: [GitHub Issues](https://github.com/vivswan/cloud-speech/issues)
- Website: [vivswan.github.io/cloud-speech](https://vivswan.github.io/cloud-speech/)

## License

MIT; see [LICENSE](LICENSE).
