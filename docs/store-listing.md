# Store listing answers

Copy-paste answers for the store dashboards. Every claim below is taken from the built manifest, the code, or the website in this repository (the "How to update" table at the end says where).

Listings covered:

| Listing | Store | ID | State |
| --- | --- | --- | --- |
| Cloud Speech (formerly Polly for Chrome) | Chrome Web Store | `kdcbeehimalgmeoeajnflggejlemclnn` | Published, still carries Polly-era text |
| Azure Speech for Chrome (legacy) | Chrome Web Store | `dkkdafmbplibmfajcdlfpicngpnkaloc` | Published, receives the same zip |
| Cloud Speech | addons.mozilla.org | gecko id `cloud-speech@vivswan.github.io` | First submission is manual |

## Do first

These still point at the Polly-era site or describe Polly only. Replace them on the Cloud Speech listing (then repeat on the Azure listing):

1. Store listing > Homepage URL -> `https://vivswan.github.io/cloud-speech/`
2. Store listing > Support URL -> `https://github.com/vivswan/cloud-speech/issues`
3. Privacy > Privacy policy URL -> `https://vivswan.github.io/cloud-speech/privacy/`
4. Store listing > Official URL -> re-check the dropdown; it must not name a polly-for-chrome site (see "Official URL" below)
5. Privacy > Single purpose -> replace the Polly-only text with the one in "Single purpose description"

## What the built manifest says

Source: `apps/extension/.output/chrome-mv3/manifest.json` after `bun run build:chrome` (Firefox: `bun run build:firefox`, `.output/firefox-mv3/manifest.json`).

| Field | Chrome | Firefox |
| --- | --- | --- |
| `name` | Cloud Speech | Cloud Speech |
| `description` (the store summary, 86 of 132 chars) | Turn highlighted text into high-quality natural speech using multiple cloud providers. | same |
| `permissions` | `contextMenus`, `downloads`, `storage`, `activeTab`, `scripting`, `offscreen` | same minus `offscreen` |
| `optional_permissions` | none | none |
| `host_permissions` | `<all_urls>` | `<all_urls>` |
| `content_scripts[].matches` | `<all_urls>` (`content-scripts/content.js`) | same |
| `commands` | `readAloudShortcut` Ctrl+Shift+S (Mac: Command+Shift+S); `downloadShortcut` Ctrl+Shift+E (Mac: Command+Shift+E) | same |
| `homepage_url` | `https://vivswan.github.io/cloud-speech/` | same |
| `minimum_chrome_version` / `strict_min_version` | 116 | 115.0 |
| Firefox `data_collection_permissions.required` | n/a | `websiteContent`, `authenticationInfo` |

Network traffic (grep of `fetch(` plus the AWS SDK in `src/providers/`): the extension itself talks only to the user's chosen provider. No analytics, no telemetry, no server of ours. User clicks open pages in new tabs: the website (Help, setup guides) and, from the Feedback view, a GitHub new-issue URL prefilled with the extension version, install source, browser version, and selected provider name (`apps/extension/src/components/app/views/Feedback.tsx`).

| Provider | Hosts contacted | Credentials asked for |
| --- | --- | --- |
| Amazon Polly | the AWS Polly endpoint of the entered region, resolved by the AWS SDK (`polly.<region>.amazonaws.com` in the standard partition; China, sovereign, and isolated partitions have their own suffixes) | Access Key ID, Secret Access Key, Region |
| Azure Speech | `<region>.tts.speech.microsoft.com` (`.azure.cn` / `.azure.us` for sovereign regions) | Subscription Key, Region |
| Google Cloud TTS | `texttospeech.googleapis.com` | API Key |
| OpenAI | `api.openai.com` | API Key |
| OpenAI-compatible | the Server URL the user types (`<base>/audio/speech`, `<base>/audio/voices`) | Server URL; API key, voice list, model list optional |

## 1. Chrome Web Store: Cloud Speech (`kdcbeehimalgmeoeajnflggejlemclnn`)

### Store listing tab

**Title**: taken from the manifest (`Cloud Speech`). Not editable.

**Summary**: taken from the manifest description (`extDescription` in `apps/extension/src/locales/en.yml`). Not editable in the dashboard.

**Description** (limit 16000; this text is about 3400 chars):

```text
Cloud Speech reads any highlighted text aloud with the cloud voice you choose. Bring your own API key for Amazon Polly, Azure Speech, Google Cloud Text-to-Speech, OpenAI, or any OpenAI-compatible server. The extension has no servers of its own: your text goes only to the provider you picked, and your keys stay in your browser.

HOW IT WORKS
1. Connect one or more providers in Settings with your own credentials. Save & test checks them.
2. Pick a voice in Preferences. Every voice from every connected provider is in one searchable picker, tagged by provider.
3. Highlight text on any page, then right-click > Read aloud, or press Ctrl+Shift+S (Command+Shift+S on Mac).

FEATURES
- Providers: Amazon Polly, Azure Speech, Google Cloud TTS, OpenAI, and OpenAI-compatible servers (Groq, DeepInfra, LiteLLM, LocalAI, Speaches, and others)
- One voice picker for all providers: search, filter by language, preview any voice before selecting it, star your favorites
- Read aloud from the context menu (normal, 1.5x, 2x speed), the keyboard shortcut, or the popup Sandbox
- Mini-player: play/pause, back and forward 15 seconds, live speed control
- Download any selection as an MP3 file: right-click > Download audio, or Ctrl+Shift+E (Command+Shift+E on Mac)
- Speed, pitch, volume gain, and speaking style, where the selected voice supports them
- Long selections are split into chunks automatically and stitched back together
- Interface in English, Hindi, Simplified Chinese, and Traditional Chinese
- Light, dark, or system theme
- Export and import your settings as a JSON file

YOUR KEYS, YOUR DATA
- Credentials are stored in your browser only: in Chrome sync (default) or on this device only (Settings > Sync)
- Selected text is sent directly to the one provider you selected, with your own credentials. The cloud providers are HTTPS-only; a self-hosted OpenAI-compatible server on your own machine may use plain http.
- No analytics, no tracking, no servers of ours. The source code is public.
- The Feedback buttons open a pre-filled GitHub issue page in a new tab. The prefilled fields (extension version, install source, browser version, selected provider name) travel in that page's URL, so GitHub sees them when the page opens; you can edit them before submitting.
- Privacy policy: https://vivswan.github.io/cloud-speech/privacy/

PRICING
- The extension is free. You pay your provider for what you use; most providers have a free tier.
- Comparison and tips: https://vivswan.github.io/cloud-speech/pricing/

SETUP GUIDES
- Amazon Polly: https://vivswan.github.io/cloud-speech/setup/polly/
- Azure Speech: https://vivswan.github.io/cloud-speech/setup/azure/
- Google Cloud TTS: https://vivswan.github.io/cloud-speech/setup/google/
- OpenAI: https://vivswan.github.io/cloud-speech/setup/openai/
- OpenAI-compatible services (Groq, DeepInfra, LiteLLM): https://vivswan.github.io/cloud-speech/setup/custom/
- Any other model (LiteLLM proxy, self-hosted LocalAI or Speaches): https://vivswan.github.io/cloud-speech/setup/local/

SUPPORT
- Troubleshooting: https://vivswan.github.io/cloud-speech/troubleshooting/
- Bugs and feature requests: https://github.com/vivswan/cloud-speech/issues
- Source code: https://github.com/vivswan/cloud-speech

FORMERLY POLLY FOR CHROME
Cloud Speech is the same extension, renamed. Amazon Polly is still fully supported, and settings from Polly for Chrome were carried over by the update.
```

**Category**: Accessibility.

**Language**: English. (The package ships en, hi, zh_CN, zh_TW; add store translations only when you have the text for them.)

| Field | Value |
| --- | --- |
| Homepage URL | `https://vivswan.github.io/cloud-speech/` |
| Support URL | `https://github.com/vivswan/cloud-speech/issues` |
| Official URL | The dropdown lists only sites verified in Google Search Console for this developer account. Select `vivswan.github.io` if it is verified; otherwise leave it at None. Verifying needs a Search Console token on the site (an `apps/web` change, not a dashboard field). |

**Store icon (128 x 128)**: `apps/extension/.output/chrome-mv3/icons/128.png` (generated from `apps/extension/src/assets/icon.svg` by `@wxt-dev/auto-icons` on every build). A redesigned icon is planned; until it ships, upload this one.

**Screenshots** (1280 x 800, PNG, no alpha; 3 to 5). Take them from a dev build with real credentials, on a light theme unless noted:

| # | What it shows | How to stage it |
| --- | --- | --- |
| 1 | Context menu on a web page: `Read aloud`, `Read aloud at 1.5x`, `Read aloud at 2x`, `Download audio`, `Stop reading` | Highlight a paragraph on any article page, right-click, capture the page and the menu |
| 2 | Popup > Preferences: the voice picker with provider chips, search box, a voice row with the preview button and a starred favorite | Connect at least two providers so two provider badges appear |
| 3 | Popup > Settings: the provider accordion with Amazon Polly, Azure Speech, Google Cloud TTS, OpenAI, OpenAI-compatible; one open showing Connected, one showing Off | Expand one provider so the credential fields and `Save & test` are visible |
| 4 | Popup > Sandbox with the mini-player: text area, `Text is sent to <provider>` line, play/pause, back 15 / forward 15, speed | Start a reading first so the player is live |
| 5 | Dark theme variant of screenshot 2 or 4 | Preferences > Appearance > Theme: Dark |

**Promo tiles** (optional): small 440 x 280, marquee 1400 x 560. Use the icon plus the summary line, once the redesigned icon ships.

### Privacy tab

**Single purpose description** (limit 1000; this text is about 620 chars):

```text
Cloud Speech has one purpose: turn text the user highlights on a web page (or types in the popup) into speech with a cloud text-to-speech provider the user has connected with their own credentials (Amazon Polly, Azure Speech, Google Cloud Text-to-Speech, OpenAI, or an OpenAI-compatible server), then play that audio in the browser or save it as an audio file. Everything in the extension serves that: the context menu items and keyboard shortcuts start or stop a reading, the popup holds the voice picker and playback controls, and Settings stores the provider credentials the synthesis requests are authenticated with.
```

**Permission justifications** (limit 1000 each). One entry per permission in the built manifest; delete any justification the dashboard still holds for a permission that is not in this table.

`contextMenus`:

```text
Adds the right-click items "Read aloud", "Read aloud at 1.5x", "Read aloud at 2x", and "Download audio" on selected text, and "Stop reading" on every context. They are the main way to start reading the highlighted text; the menu titles follow the extension's display language.
```

`downloads`:

```text
Saves synthesized speech as a file (tts-download.mp3) when the user picks "Download audio" in the context menu, presses the download shortcut (Ctrl+Shift+E), or clicks Download in the popup Sandbox for the text typed there. Also saves the optional settings export (cloud-speech-settings-<date>.json) from Settings > Backup. Every file is built locally from data the user explicitly asked to save; nothing is downloaded on its own.
```

`storage`:

```text
Keeps the user's settings as one object: provider credentials, the selected voice, favorites, speed, pitch, volume gain, theme, and display language. It is stored in chrome.storage.sync when the user's Sync toggle is on (the default) and in chrome.storage.local when it is off; the toggle itself always lives in local storage. Session storage holds the cached voice lists and the playback state (status, position, rate, epoch, a digest of the text being read). Local storage also holds the results of the last voice check and the one backup slot kept before a settings import. The extension's own IndexedDB caches the last synthesized audio together with its key (the text, the voice settings, and a hash of the credentials, so replaying the same text does not call the provider again), and the popup keeps its theme in its localStorage for a flicker-free first paint. Apart from the files the user saves with Download or Export, everything stays inside the browser profile.
```

`activeTab`:

```text
The keyboard shortcuts and the popup Sandbox's "Use selection" banner need the text currently highlighted in the tab the user is looking at. activeTab grants that access for the active tab at the moment the user presses the shortcut or opens the popup, which is the only moment the extension reads from a page.
```

`scripting`:

```text
Runs chrome.scripting.executeScript with a single inline function, window.getSelection().toString(), in the active tab to read the highlighted text when a keyboard shortcut fires or the popup Sandbox opens. Nothing else is injected this way, and no code is fetched from anywhere: the function is part of the packaged extension.
```

`offscreen`:

```text
Manifest V3 service workers cannot play audio. The extension creates one offscreen document (reason AUDIO_PLAYBACK) that owns the audio element for readings and voice previews; the popup's mini-player controls it through extension messages. It is created on demand and does nothing else.
```

Host permission `<all_urls>` (also the content script's match pattern):

```text
Two uses. (1) A small content script shows an error toast on the current page when a reading fails (invalid key, provider error, no voice selected). The user's selection can be on any site, so the script must be able to run on any URL. It only listens for messages from the extension's own background and draws the toast inside a shadow DOM; it reads nothing from the page and sends nothing anywhere. (2) The OpenAI-compatible provider sends synthesis requests to a server URL the user types in (for example a LiteLLM proxy or a LocalAI instance on localhost), so the hosts cannot be listed in advance. The four named providers use fixed HTTPS endpoints derived from the region the user enters: the AWS Polly endpoint for that region (polly.<region>.amazonaws.com, or the suffix of a China, sovereign, or isolated AWS partition), <region>.tts.speech.microsoft.com (or .azure.cn / .azure.us), texttospeech.googleapis.com, and api.openai.com.
```

Note for the reviewer question "why is there a Remove this extension button without the management permission": `chrome.management.uninstallSelf` does not require the `management` permission. It is used only by the legacy Azure listing's handoff banner (section 2).

**Remote code**: No. Reason (paste if a text box appears):

```text
All JavaScript ships inside the package. The only network requests the extension makes go to the text-to-speech provider the user configured (audio bytes and voice-list JSON, never executed as code) and to the extension's own bundled locale files. Help and Feedback buttons open web pages in new tabs; no code is loaded from them.
```

**Data usage** (tick exactly these two):

| Checkbox | Tick | Why |
| --- | --- | --- |
| Personally identifiable information | no | Nothing of the kind is collected |
| Health information | no | |
| Financial and payment information | no | |
| Authentication information | yes | The user's own provider API keys / access keys are stored in the browser (sync or local) and sent to that provider to authenticate each request |
| Personal communications | no | |
| Location | no | The "Region" fields are cloud data-center regions the user picks, not the user's location |
| Web history | no | |
| User activity | no | No analytics or telemetry of any kind |
| Website content | yes | The text the user highlights is sent to the provider the user selected, to be synthesized |

**Certifications**: tick all three (no sale or transfer to third parties outside the approved use cases; no use unrelated to the single purpose; no use for creditworthiness or lending). All three are true: the only recipient of user data the extension sends is the provider the user chose, for synthesis. The Feedback buttons open a GitHub new-issue page in a tab whose URL carries environment fields (extension version, install source, browser version, provider name); GitHub sees those when the page loads, and the user can edit them before submitting.

**Privacy policy URL**: `https://vivswan.github.io/cloud-speech/privacy/`

Known drift in that page (`apps/web/src/pages/privacy.astro`), to fix in its own PR: it says provider traffic is always HTTPS, but the OpenAI-compatible provider accepts a plain `http://` server URL (`apps/extension/src/lib/credential-checks.ts`, `apps/extension/src/providers/custom.ts`), and it lists four providers where the extension has five.

### Distribution and Visibility tabs

Nothing to change: Public, all regions, free.

Two-listing model, for context:

| Listing | What it receives | Who installs from it |
| --- | --- | --- |
| Cloud Speech | every release zip via `wxt submit` (`update-release.yml`, secret `CWS_EXTENSION_ID_POLLY`) | new users; former Polly for Chrome users got it as a normal update |
| Azure Speech for Chrome | the same zip (secret `CWS_EXTENSION_ID_AZURE`) | nobody new; existing users are moved over (section 2) |

## 2. Chrome Web Store: Azure Speech for Chrome (`dkkdafmbplibmfajcdlfpicngpnkaloc`)

Same package, same privacy tab. Fill it like section 1 with two differences:

1. The description opens with the move notice below, then continues with the full section 1 description.
2. Keep the listing published: unpublishing it would stop the updates that carry the handoff.

**Description opening** (prepend to the section 1 text):

```text
NOW CLOUD SPEECH. Install it here: https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn

This listing keeps receiving the same updates as Cloud Speech, but new installs should use the link above. If you already have this extension:
1. Install Cloud Speech from the link above. On its first start it imports your Azure key from this copy automatically, and your voice and preferences too if Cloud Speech is not set up yet; nothing to retype.
2. This copy then shows "Your settings were transferred to Cloud Speech" with a "Remove this extension" button; click it (Chrome asks you to confirm). This copy also removes its context menu items so you never see two "Read aloud" entries.

Below is the full Cloud Speech description.
```

How that is backed by the code (for your own reference, not for the listing):

| Claim | Where |
| --- | --- |
| Cloud Speech pulls settings from the Azure install on start | `apps/extension/src/migrations/handoff/index.ts` (`importHandoff`, `runtime.sendMessage(forkId, { type: "exportSettings" })`) |
| Existing Cloud Speech providers win; voice and preferences are taken only by a fresh install | `apps/extension/src/migrations/handoff/merge.ts` |
| The Azure copy shows the banner and the Remove button | `apps/extension/src/migrations/handoff/Banner.tsx` (`management.uninstallSelf({ showConfirmDialog: true })`) |
| The Azure copy retires its menus and shortcuts after the import | `apps/extension/src/migrations/handoff/retired.ts` |
| Which IDs are legacy | `LEGACY_IDS` in `packages/constants/src/index.ts` |

Everything else on this listing (category, URLs, icon, screenshots, single purpose, justifications, data usage, certifications, privacy policy URL) is identical to section 1.

## 3. addons.mozilla.org: Cloud Speech

Package: `apps/extension/.output/cloud-speech-<version>-firefox.zip`, built by `bun run build:firefox` together with the sources zip AMO asks for (`cloud-speech-<version>-firefox-sources.zip`).

| Field | Value |
| --- | --- |
| Name | Cloud Speech (from the manifest) |
| Add-on URL slug | your choice, e.g. `cloud-speech`; copy it into `FIREFOX_ADDON_SLUG` afterwards (see "Pipeline") |
| Summary (limit 250) | see below |
| Description | the section 1 description, with two edits: `Command+Shift+S`/`Command+Shift+E` stay, and replace "Chrome sync" with "Firefox Sync" in the YOUR KEYS line; drop the FORMERLY POLLY FOR CHROME paragraph |
| Categories | AMO has no Accessibility category. Pick `Language Support` (primary) and `Other` |
| Homepage | `https://vivswan.github.io/cloud-speech/` |
| Support website | `https://github.com/vivswan/cloud-speech/issues` |
| Support email | leave empty (issues are the support channel) |
| Privacy policy | AMO wants the text, not a URL: paste the text of `https://vivswan.github.io/cloud-speech/privacy/` (source `apps/web/src/pages/privacy.astro`) and put the URL on its first line. Fix the page's drift first (see the Privacy policy URL note in section 1) so the pasted text does not repeat it |
| License | `Custom License`; paste `LICENSE.md` (Individual and Small Organization License 1.1.0) |
| Data collection | declared in the manifest (`data_collection_permissions.required`: `websiteContent`, `authenticationInfo`); if the form asks again, answer the same two, nothing optional |
| Source code submission | Yes, upload the sources zip. Notes for the reviewer: below |

**Summary** (242 of 250 chars):

```text
Read highlighted text aloud with Amazon Polly, Azure Speech, Google Cloud TTS, OpenAI, or any OpenAI-compatible server, using your own API keys. No servers, no tracking: text goes only to the provider you pick. Preview voices, download audio.
```

**Notes to the reviewer** (source code submission):

```text
Build instructions are in README.md. Install Bun at the version pinned in .bun-version, then run: bun install --frozen-lockfile && bun run --cwd apps/extension build:firefox. The zip appears in apps/extension/.output/ and matches the uploaded one byte-for-byte apart from timestamps. The extension has no servers: the only network calls it makes are to the TTS provider the user configured (see apps/extension/src/providers/); Help and Feedback buttons open the website or a GitHub issue page in a new tab. Audio plays in the background event page (no offscreen API on Firefox; see apps/extension/src/lib/audio-host.ts).
```

**Pipeline** (`.github/workflows/update-release.yml`, "Publish to addons.mozilla.org" step):

1. The first submission is manual on the AMO Developer Hub (the listing must exist before the API can update it).
2. Set `FIREFOX_ADDON_SLUG` in `packages/constants/src/index.ts` to the slug you chose. That flips `firefoxListing` to `published`: the website shows "Add to Firefox" and the extension shows its review button on Firefox.
3. Add the repository secrets `AMO_JWT_ISSUER`, `AMO_JWT_SECRET` (API credentials from the Developer Hub) and `AMO_EXTENSION_ID` (`cloud-speech@vivswan.github.io`). Until they exist the step skips with a notice and the zips are only attached to the GitHub release.

## 4. How to update

| Field | Source | Where to change it |
| --- | --- | --- |
| Title (all stores) | manifest `name` | `EXTENSION_NAME` in `packages/constants/src/index.ts` |
| Summary (CWS) | manifest `description` | `extDescription` in `apps/extension/src/locales/en.yml` (and the other three locales) |
| Version | manifest `version` | root `package.json`, bumped by release-please |
| Permissions, host permissions, commands, default shortcuts | manifest | `apps/extension/wxt.config.ts` (`manifest`), shortcuts via `SHORTCUTS` in `packages/constants/src/index.ts` |
| Content script match pattern | manifest | `apps/extension/src/entrypoints/content.ts` |
| Firefox data collection declaration | manifest | `apps/extension/wxt.config.ts` (`data_collection_permissions`) |
| Homepage URL | manifest `homepage_url` and dashboard | `SITE_URL` in `packages/constants/src/index.ts`; also retype in the dashboard |
| Icon | package | `apps/extension/src/assets/icon.svg` (auto-icons renders the PNGs); also re-upload in the dashboard |
| Store listing IDs, legacy IDs, AMO slug | code | `POLLY_ID`, `AZURE_ID`, `UNIFIED_ID`, `LEGACY_IDS`, `FIREFOX_ADDON_SLUG` in `packages/constants/src/index.ts` |
| Provider roster and display names | code | `PROVIDER_IDS`, `PROVIDER_NAMES` in `packages/constants/src/index.ts`; credential fields in `apps/extension/src/providers/<id>.ts` |
| Context menu titles, banner text, UI strings quoted in justifications | code | `apps/extension/src/locales/*.yml` |
| Description, category, support URL, official URL, screenshots, promo tiles | dashboard only | this file, then the dashboard |
| Single purpose, permission justifications, remote code, data usage, certifications | dashboard only | this file, then the dashboard |
| Privacy policy text | website | `apps/web/src/pages/privacy.astro` (URL stays `/privacy/`) |
| Setup, pricing, troubleshooting URLs quoted in the description | website | `apps/web/src/pages/**` (paths are the page file names; `setup/custom/hosted/` and `setup/custom/local/` are redirects in `apps/web/astro.config.mjs`) |
| Which listings get published | CI | `.github/workflows/update-release.yml` plus the `CWS_*` and `AMO_*` repository secrets |

When a manifest permission changes, update the justification block in section 1 in the same PR, then paste it into both Chrome listings.
