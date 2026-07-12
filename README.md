# Cloud Speech for Chrome

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/kdcbeehimalgmeoeajnflggejlemclnn.svg)](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn)
[![GitHub Pages](https://img.shields.io/badge/website-cloud--speech--for--chrome-blue)](https://vivswan.github.io/cloud-speech-for-chrome/)
[![GitHub](https://img.shields.io/github/license/vivswan/cloud-speech-for-chrome)](LICENSE)

Turn highlighted text on any web page into natural speech using **multiple cloud
text-to-speech providers** — Amazon Polly, Azure Speech, Google Cloud TTS, and OpenAI — from a
single extension.

**[Visit Website](https://vivswan.github.io/cloud-speech-for-chrome/)**

## Features

- **Multi-provider** — connect Amazon Polly, Azure Speech, Google Cloud TTS, and/or OpenAI
  with your own credentials; all voices appear in one searchable picker, tagged by provider
- **Voice audition** — preview any voice before selecting it; star your favorites
- **Read aloud** — context menu, keyboard shortcut (`Ctrl/Cmd+Shift+S`), or the popup sandbox,
  with playback controls and live speed adjustment
- **Download audio** (`Ctrl/Cmd+Shift+E`) — save any selection as an audio file (MP3 by
  default, or another format the provider offers)
- **Prosody controls** — speed, pitch, volume, and speaking styles, shown only when the selected
  provider/voice supports them
- **Multi-language interface** — English, Chinese (Simplified & Traditional), and Hindi
- **Your keys, your data** — credentials stay in your browser (Chrome sync optional) and text is
  sent only to the provider you choose

## Store listings

The same codebase ships under three Chrome Web Store listings, so users of the original
single-provider extensions keep receiving updates and are migrated automatically (credentials
included):

| Listing | Purpose |
| --- | --- |
| **Cloud Speech for Chrome** | The unified extension — recommended for new users |
| **Polly for Chrome** | Updates the original Polly extension in place |
| **Azure Speech for Chrome** | Updates the original Azure extension in place |

## Development

Built with [WXT](https://wxt.dev), React 19, TypeScript (strict), Tailwind CSS v4, and Bun.

```bash
bun install          # install dependencies
bun run dev          # dev mode with HMR (opens Chrome with the extension loaded)
bun run build        # production build (cloud listing) → .output/chrome-mv3-cloud
bun run build:all    # build all three listings
bun run test         # vitest
bun run check        # biome lint + format
bun run typecheck    # tsc --noEmit (strict)
```

Load an unpacked build from `.output/chrome-mv3-<mode>/` via `chrome://extensions` (Developer
mode).

### Architecture in one paragraph

Provider-specific logic (SDK calls, credential fields, voice normalization, SSML/prosody) lives
entirely behind the `TtsProvider` interface in `src/providers/` — one file per provider plus a
registry. Everything else (playback transport, offscreen audio, storage, UI) is
provider-agnostic and registry-driven. Adding a new TTS API = one new provider file + one
registry line + locale strings.

## Support

- **Issues / feature requests**: [GitHub Issues](https://github.com/vivswan/cloud-speech-for-chrome/issues)
- **Website**: [vivswan.github.io/cloud-speech-for-chrome](https://vivswan.github.io/cloud-speech-for-chrome/)

## License

MIT — see [LICENSE](LICENSE).
