# Store listing answers

Copy-paste answers for the store dashboards. Every claim below about the extension is taken from the built manifest, the code, or the website in this repository (the "How to update" table at the end says where). Notes on what a dashboard currently holds are maintainer observations from the last look at it: check them in the dashboard before acting.

Listings covered:

| Listing | Store | ID | State |
| --- | --- | --- | --- |
| Cloud Speech (formerly Polly for Chrome) | Chrome Web Store | `kdcbeehimalgmeoeajnflggejlemclnn` | Published; its listing text was still Polly-era at the last check |
| Azure Speech for Chrome (legacy) | Chrome Web Store | `dkkdafmbplibmfajcdlfpicngpnkaloc` | Published, receives the same zip |
| Cloud Speech | addons.mozilla.org | gecko id `cloud-speech@vivswan.github.io` | First submission is manual |

## Do first

At the last check these fields still pointed at the Polly-era site or described Polly only. Check each in the dashboard and replace it on the Cloud Speech listing (then repeat on the Azure listing):

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
| `permissions` | `contextMenus`, `downloads`, `storage`, `scripting`, `offscreen` (`activeTab` was dropped by PR #165 "fix: drop the redundant activeTab permission": `<all_urls>` already covered it) | same minus `offscreen` |
| `optional_permissions` | none | none |
| `host_permissions` | `<all_urls>` | `<all_urls>` |
| `content_scripts[].matches` | `<all_urls>` (`content-scripts/content.js`) | same |
| `commands` | `readAloudShortcut` Ctrl+Shift+S (Mac: Command+Shift+S); `downloadShortcut` Ctrl+Shift+E (Mac: Command+Shift+E) | same |
| `homepage_url` | `https://vivswan.github.io/cloud-speech/` | same |
| `minimum_chrome_version` / `strict_min_version` | 116 | 115.0 |
| Firefox `data_collection_permissions.required` | n/a | `websiteContent`, `authenticationInfo` |

Network traffic (grep of `fetch(` plus the AWS SDK in `src/providers/`; the one other `fetch(`, in `lib/i18n-runtime.ts`, reads the bundled locale files from the package through `runtime.getURL`, not from the network): the extension itself talks only to the providers the user gives credentials to. No analytics, no telemetry, no server of ours. A provider is contacted:

- on Save & test of its credentials:
  - a validation call (`lib/provider-validation.ts` runs the provider's `validateAndFetchVoices`; throttling and 5xx are retried and Polly's voice list is paginated, so it can be more than one request). For Amazon Polly, Azure, and Google that call IS the voice-list request. OpenAI gets a speech request for the word "Hi". An OpenAI-compatible server gets its voice-list request (unless the list is typed) and then the same "Hi" speech request
  - once the validation succeeds, a one-character voice check per voice family (`lib/probe.ts`, started by Settings)
- while enabled and configured, on every voice-list refresh (`lib/voices.ts` `fetchAllVoices`), except where the list needs no request: OpenAI's ships in the package (`providers/openai.ts` `STATIC_VOICES`), and an OpenAI-compatible server with a typed voice list is not asked (`providers/custom.ts`)
- for synthesis, only when its voice is selected (or previewed): the user's text goes to that provider alone

Pages that open in a new tab when the user clicks (every `browser.tabs.create` under `apps/extension/src`):

- The website: Help opens the homepage (`components/app/Sidebar.tsx`, `homepageUrl`) and each provider's "Where do I get this?" link opens its setup guide (`components/app/views/Settings.tsx`, `guideUrl`); `lib/guide.ts` only builds the URLs
- The GitHub repository (the Sidebar's GitHub button)
- A GitHub new-issue page (`components/app/views/Feedback.tsx`; PR #164 "fix: prefill the bug report's environment field from the Feedback view" added the `environment` field):
  - Report a bug puts what the extension knows in the URL under the bug form's field ids, so GitHub prefills them: `version` (extension version), `listing` (install source), `environment` (browser and its version, "Chrome 1xx..." or "Firefox 1xx"; left out when the user agent hides the version), `provider` (selected provider name; left out when no voice is selected)
  - Request a feature carries only the template name, no environment data
- The store review page of the listing the install came from (Feedback > Leave a review, `lib/listing.ts` `reviewUrl`; store installs only)
- `chrome://extensions/shortcuts` (Preferences > Edit shortcuts, `components/app/views/Preferences.tsx`)
- The Cloud Speech store page (the legacy listing's handoff banner, `migrations/handoff/Banner.tsx`)

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

**Description** (limit 16000; this text is about 4500 chars):

```text
Cloud Speech reads any highlighted text aloud with the cloud voice you choose. Bring your own API key for Amazon Polly, Azure Speech, Google Cloud Text-to-Speech, OpenAI, or any OpenAI-compatible server. The extension has no servers of its own: it talks only to the providers you give credentials to, your text goes only to the one whose voice you picked, and your keys are stored in your browser profile (synced through your browser account while Sync is on, the default), never sent to the extension's author.

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
- Credentials are stored in your browser profile. While Sync is on (the default) the browser syncs them through your browser account; turn it off in Settings > Sync to keep them on this device only. They are never sent to the extension's author.
- Selected text is sent directly to the one provider whose voice you selected, with your own credentials.
- The other providers you gave credentials to are contacted only when you click Save & test (a short validation request and a voice check), when you preview one of their voices (a built-in sample sentence), and, while enabled, when their voice list is fetched (OpenAI's list is built in, and a voice list you type for an OpenAI-compatible server is used as is, so neither is asked). No other provider is contacted.
- The four named cloud providers are HTTPS-only; an OpenAI-compatible server URL you type yourself may be plain http, in which case your key and text travel unencrypted to that server.
- No analytics, no tracking, no servers of ours. The source code is public.
- Feedback > Report a bug opens a GitHub new-issue page in a new tab with the bug form's version, listing, environment, and provider fields prefilled from the URL (extension version, install source, browser with its version such as "Chrome 1xx...", and selected provider name), so GitHub sees them when the page opens. A value the extension does not know, such as the provider before you pick a voice, is left blank. You can edit everything before submitting.
- Feedback > Request a feature opens the feature form with nothing prefilled.
- Feedback > Leave a review opens this listing's review page on the store.
- Privacy policy: https://vivswan.github.io/cloud-speech/privacy/

PRICING
- The extension is free for individuals and for small organizations' internal use (Individual and Small Organization License, LICENSE.md in the repository). You pay your provider for what you use; most providers have a free tier.
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

**Store icon (128 x 128)**: `apps/extension/.output/chrome-mv3/icons/128.png` (generated from `apps/extension/src/assets/icon.svg` by `@wxt-dev/auto-icons` on every build). Upload that 128 px PNG from the built package.

**Screenshots** (1280 x 800, JPEG; the store takes 3 to 5, the set has 10). No image file is committed to main: CI renders the set from the built extension. Each render writes two files per scene and one `crops.json` for the set.

| Variant | Size | File | Shown |
| --- | --- | --- | --- |
| Store upload, a focus crop of the composition | 1280 x 800 | `<scene>.jpg` | The store listing; the walkthrough page's frames |
| Whole composition | 2560 x 1600 | `<scene>-2x.jpg` | The walkthrough page's lightbox; the README |

`crops.json` records where each store crop sits in its composition (for checking a crop, and as the marker that a render finished: the renderer removes it first and writes it last):

| Field | Meaning |
| --- | --- |
| `scene` | The scene's name, `01-context-menu` and so on |
| `store` | The store file, `<scene>.jpg` |
| `full` | The whole composition, `<scene>-2x.jpg` |
| `size` | The `-2x` image's size, `{ width, height }` in its pixels |
| `window` | The store crop's rectangle in the `-2x` image, `{ left, top, width, height }` in its pixels |

Get them from one of:

| Source | Where | Rendered from |
| --- | --- | --- |
| The `store-screenshots` branch | `https://raw.githubusercontent.com/Vivswan/cloud-speech/store-screenshots/<file>`: an orphan branch (one commit), replaced a minute or two after each green CI run of main (`publish-screenshots.yml`) | Latest green main |
| A green main commit | The `store-screenshots-<sha>` artifact of that commit's CI run, kept 90 days (uploaded by the `post-green.yml` job the run calls); the branch above is a copy of the newest one | That commit |
| Your machine | `bun run screenshots:store` writes `apps/extension/.output/store-screenshots/` (gitignored) | Your working tree, with your OS's fonts |

- `bun run dev` renders that local set first (when it is missing or older than the extension source, the workspace packages, or the renderer, and it says which file made it stale) and the website's dev server serves it to the walkthrough page; the production build serves the published branch. Frame and lightbox always come from the same set, so what the frame shows is the store crop.

Upload scenes 1 to 5 as their `<scene>.jpg` files, as they are; the store takes five at most. Scenes 6 to 10 are rendered for the website's walkthrough page (apps/web/src/pages/walkthrough.astro). Take them from CI, not from a Mac: the popup bundles its typeface, so the glyphs match everywhere, but the shortcut labels follow the OS, `Ctrl` on the Linux runner and `Cmd` in a local render on macOS.

How they are made (`apps/extension/tests/e2e/store-screenshots.ts`, run through `apps/extension/playwright.screenshots.config.ts`):

- The built extension runs in headless Chromium against the e2e fake speech server (`apps/extension/tests/e2e/fake-provider/`), so no provider keys are involved.
  The command builds `.output/chrome-mv3` first, every time, so the shots never come from a stale bundle.
- Three providers show as connected: OpenAI-compatible points at the fake server, the OpenAI provider's requests to api.openai.com are routed to the same server, and Azure Speech (connected by scene 7) is answered from the script itself: a roster of three voices and silent audio.
  Every label, voice name, and control is the real UI; only the audio is fake.
  The OpenAI-compatible voice names (`Bella`, `Adam`, ...) are labels entered in the provider's voice-names field; the fake server accepts any name.
- Every scene is one composition rendered at device scale 2 (2560 x 1600): the popup keeps its real layout, 600 px tall (Chrome's popup cap) and as wide as Chrome opens it.
  Chrome lays the popup out at the lower bound popup/index.html puts on body and widens it only when the content overflows that, up to the upper bound; it does not widen it to the content's preferred width.
  Measured on the native popup of the Chromium the renderer runs in, every view opens at the lower bound, 600 px, and the renderer sizes each scene the same way, after the view has filled in and again after a scene changes it.
  A scene whose content overflows its popup when it is captured fails. The popup is centered on a plain background with a drop shadow. That render is the `-2x.jpg` file.
- The store file is a focus crop of the same render: a 640 x 400 window of the composition placed from the elements' bounding boxes and written pixel for pixel,
  so a 12 px popup label is 24 px tall in the file. Nothing is scaled: a focus that does not fit the window fails the scene, and so does a window that would leave the composition, instead of being moved back in.
  A window that reaches past the popup's top or bottom edge shows at least 12 px of the background there, so the edge and its corners read as the popup's.
  Neither edge cuts through a line of text anywhere across the window, the sidebar included: a window edge through a line of text fails the scene.
  The popup is narrower than the window, so every popup crop shows its whole width, the window centered on it, with 20 px of background at each side.
- JPEG at quality 92 with 4:4:4 chroma (no color fringing on text) through mozjpeg. Light theme unless noted.
- The script exits non-zero when a scene fails, the popup is not 600 px tall or its content overflows its width when captured, a focus does not fit the store window or its window leaves the composition, or a written file is not an RGB JPEG of its set's size.

| # | Files | What the store crop shows | How the script stages it |
| --- | --- | --- | --- |
| 1 | `01-context-menu.jpg`, `-2x` | The highlighted paragraph with the context menu under its last line: `Read aloud`, `Read aloud at 1.5x`, `Read aloud at 2x`, `Download audio`, `Stop reading`; the composition adds the article's title and lede | Headless Chromium cannot show a native context menu, so this scene is a drawn stand-in: an article page with a highlighted paragraph and a text-selection menu whose Cloud Speech submenu is open. The item titles come from the built locale file and the icon from the build. |
| 2 | `02-preferences-voice-picker.jpg`, `-2x` | The Voice field with Nova selected and the open picker: search box, provider chips on Favorites, the five starred rows with preview buttons and filled stars, the selected row highlighted; the window starts under the Voice language select and ends above the Keyboard shortcuts heading, the view scrolled so both edges miss the sidebar's labels | OpenAI and OpenAI-compatible connected; Nova selected; Nova, Bella, and Adam starred |
| 3 | `03-settings-providers.jpg`, `-2x` | Settings from the popup's top corners down: the Providers heading, the Amazon Polly, Azure Speech, and Google Cloud TTS rows, and the expanded OpenAI card (Connected with its voice count, API key field, Enabled switch, `Save & test`), the window ending in the gap under the card; the composition shows the whole accordion | The view is scrolled the few pixels that put the gap under the card at the window's bottom edge |
| 4 | `04-sandbox-player.jpg`, `-2x` | The bottom of the Sandbox during a read, the sidebar's lower items beside it: the last lines of the text box (cut between two lines, never through one), the character count, `Text is sent to OpenAI`, and the player (pause, timeline, back 15 / forward 15, speed, download) down to the card's bottom corners | The article text is pasted into the Sandbox; the read plays the fake server's silent audio and is captured 6 s in |
| 5 | `05-preferences-dark.jpg`, `-2x` | Screenshot 2 in the dark theme | Preferences > Appearance > Theme: Dark, and back to System afterwards |
| 6 | `06-sandbox-reading-page.jpg`, `-2x` | The top of the Sandbox opened during a read of a page selection: the popup's top corners, the Sandbox title, the `Use selection` banner quoting the page's highlighted text, and the first lines of the article in the text box, cut between two lines | An article page holds the selection (the highlighted paragraph of screenshot 1); the read starts from it the way the context menu starts one, then the popup is reloaded so it mounts mid-read, and the article text goes back into the box |
| 7 | `07-preferences-prosody.jpg`, `-2x` | The whole Voice & prosody card with the sidebar beside it: Voice language on All, the Voice field with Jenny (American English, Azure Speech), the preview tip, the Speed, Pitch, and Volume gain sliders, and the Speaking style select; the window starts in the gap under the card's heading and ends in the gap above the Audio format heading | Azure Speech connected against the in-script stub; the language filter set to All and Jenny selected, the one voice here with pitch, volume, and styles |
| 8 | `08-settings-sync.jpg`, `-2x` | The bottom of Settings: the Sync card with its switch on and the `Saved to your browser account` hint, the Backup card (`Export`, `Import`), the Display language card, down to the card's bottom corners | Settings scrolled to its end; the window starts in the gap above the Sync heading |
| 9 | `09-settings-save-test-error.jpg`, `-2x` | The OpenAI card expanded after a failed `Save & test`: the key field, the verdict (`Key rejected`, `Re-copy the key and try again.`, the `Open the OpenAI setup guide` link, and a collapsed `Details` holding the HTTP 401 and OpenAI's own wording), the row's `Not connected` chip, and the Not connected Google Cloud TTS row above it, down to the card's bottom corners; the window starts in the gap above the Google Cloud TTS row | Runs first, before any provider is connected; a request carrying the scene's revoked key is answered with 401 and OpenAI's rejected-key error envelope instead of reaching the fake server |
| 10 | `10-preferences-shortcuts.jpg`, `-2x` | The end of Preferences: the Audio format card (Download, Read aloud), the Appearance card (Theme), and the Keyboard shortcuts card (the two bindings, `Edit shortcuts`), down to the popup's bottom corners | Preferences scrolled to its end; the window starts in the gap above the Audio format heading |

**Promo tiles** (optional): small 440 x 280, marquee 1400 x 560. Use the current 128 px icon plus the summary line.

### Privacy tab

**Single purpose description** (limit 1000; this text is about 650 chars):

```text
Cloud Speech has one purpose: turn text the user highlights on a web page (or types in the popup) into speech with a cloud text-to-speech provider the user has connected with their own credentials (Amazon Polly, Azure Speech, Google Cloud Text-to-Speech, OpenAI, or an OpenAI-compatible server), then play that audio in the browser or save it as an audio file. Everything in the extension serves that: the context menu items and keyboard shortcuts start or stop a reading or save its audio as a file, the popup holds the voice picker and playback controls, and Settings stores the provider credentials the synthesis requests are authenticated with.
```

**Permission justifications** (limit 1000 each). One entry per permission in the package the dashboard currently holds. The dashboard refuses to save the Privacy tab while any declared permission lacks a justification, so a permission only the OLD package declares still needs text until the new package is uploaded; delete it afterwards.

`activeTab` (declared by 1.0.6 and older only; the 2.x package drops it, so delete this entry once 2.x is uploaded). This block describes the 1.0.6 code, while every other block in this section describes the 2.x package, so the two differ on purpose: in 2.x the Sandbox also reads the page selection through `scripting`, in 1.0.6 it did not:

```text
Reads the text the user has highlighted on the current tab when they press the read-aloud or download keyboard shortcut. In response to that key press the extension runs one packaged function on the active tab through chrome.scripting.executeScript; it returns the selected text (the selection inside a focused text field, otherwise the page selection) and nothing else. No code is fetched from a server, and pages are never read in the background or on other tabs. Context-menu reads use the selection text Chrome passes with the menu click and need no injection; the popup Sandbox reads the text typed into it. The next version drops this permission because the host permission already covers the same read.
```

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
Keeps the user's settings as one object: provider credentials, selected voice, favorites, speed, pitch, volume gain, theme, display language. While the Sync toggle is on (the default) it lives in chrome.storage.sync, which the browser syncs through the user's browser account; when off, in chrome.storage.local. The toggle itself is always local. Session storage holds the cached voice lists, the playback state (position, rate, text digest), and the voice being previewed. Local storage also holds the voice-check results, the backup kept before a settings import, and the settings-handoff records from the legacy listing (banner state, imported installs). The extension's own IndexedDB caches the last synthesized audio, keyed by text, voice settings, and a credential hash; the popup mirrors the theme in localStorage. Nothing in it goes to the extension's author.
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
All JavaScript ships inside the package. The only network requests the extension makes go to the text-to-speech providers the user gave credentials to (audio bytes and voice-list JSON, never executed as code); its locale files are read from the package itself, not from the network. Help and Feedback buttons open web pages in new tabs; no code is loaded from them.
```

**Data usage** (tick exactly these two):

| Checkbox | Tick | Why |
| --- | --- | --- |
| Personally identifiable information | no | Nothing of the kind is collected |
| Health information | no | |
| Financial and payment information | no | |
| Authentication information | yes | The user's own provider API keys / access keys are stored in the browser profile (synced through the browser account while Sync is on) and sent to that provider to authenticate each request |
| Personal communications | no | |
| Location | no | The "Region" fields are cloud data-center regions the user picks, not the user's location |
| Web history | no | |
| User activity | no | No analytics or telemetry of any kind |
| Website content | yes | The text the user highlights is sent to the provider the user selected, to be synthesized |

**Certifications**: tick all three (no sale or transfer to third parties outside the approved use cases; no use unrelated to the single purpose; no use for creditworthiness or lending).

All three are true. User data leaves the extension by these routes, each set up by the user:

- Every provider the user gives credentials to receives them: on Save & test (validation request and voice check), on a preview of one of its voices (built-in sample sentence), and, while enabled, whenever its voice list is fetched from it (not OpenAI, whose list is built in, nor an OpenAI-compatible server with a typed voice list). The one whose voice is selected also receives the selected text, for synthesis.
- The browser's own sync carries the settings object (credentials included) through the user's browser account while Sync is on (the default); the extension writes to chrome.storage.sync and the browser does the rest.
- GitHub receives the bug form's version, listing, environment, and provider values (extension version, install source, browser and its version, selected provider name; each only when the extension knows it) in the URL of the new-issue page Feedback > Report a bug opens (`Feedback.tsx` `bugReportFields`); Request a feature sends only the template name. The form is editable before submitting.
- Files the user saves go to the user's own disk: audio downloads, and the settings export, which includes the credentials.

**Privacy policy URL**: `https://vivswan.github.io/cloud-speech/privacy/`

The page (`apps/web/src/pages/privacy.astro`) names all five providers and says an OpenAI-compatible server URL may be plain `http://` (PR #163 "fix(web): make the privacy policy match the five providers and self-hosted http servers").

### Distribution and Visibility tabs

Check that they read Public, all regions, free (what they showed at the last check); nothing in this repository sets them.

Two-listing model, for context:

| Listing | What it receives | Who installs from it |
| --- | --- | --- |
| Cloud Speech | every release zip via `wxt submit` (`update-release.yml`, secret `CWS_EXTENSION_ID_POLLY`) | new users; former Polly for Chrome users got it as a normal update |
| Azure Speech for Chrome | the same zip (secret `CWS_EXTENSION_ID_AZURE`) | nobody new; existing users are moved over (section 2) |

## 2. Chrome Web Store: Azure Speech for Chrome (`dkkdafmbplibmfajcdlfpicngpnkaloc`)

Same package, same privacy tab. Fill it like section 1 with two differences:

1. The description opens with the move notice below, then continues with the section 1 description minus its FORMERLY POLLY FOR CHROME paragraph (this listing's users came from Azure Speech for Chrome, not from Polly).
2. Keep the listing published. The pipeline uploads every release zip to it (`update-release.yml`, secret `CWS_EXTENSION_ID_AZURE`), and that update is what brings the handoff code to the installs already out there.

**Description opening** (prepend to the section 1 text without its FORMERLY POLLY FOR CHROME paragraph):

```text
NOW CLOUD SPEECH. Install it here: https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn

This listing keeps receiving the same updates as Cloud Speech, but new installs should use the link above. If you already have this extension:
1. Install Cloud Speech from the link above. Each time it starts it asks this copy for your settings, until the transfer succeeds: it imports your Azure key (if Cloud Speech already has an Azure key of its own, it keeps that one), your starred voices (added to any it already has), and your voice and preferences too if Cloud Speech has no saved provider credentials yet; nothing to retype. This copy must have received its latest update first; if it has not, the transfer happens on a later start.
2. This copy then shows "Your settings were transferred to Cloud Speech" with a "Remove this extension" button; click it (Chrome asks you to confirm). This copy also removes its context menu items so you never see two "Read aloud" entries.

Below is the Cloud Speech description.
```

How that is backed by the code (for your own reference, not for the listing):

| Claim | Where |
| --- | --- |
| Cloud Speech asks the Azure install for its settings on every start until an import is recorded; an Azure copy without the handoff update (no `exportSettings` handler) answers nothing, so that start imports nothing and the next one asks again | `apps/extension/src/migrations/handoff/index.ts` (`importHandoff`, `fetchHandoffSnapshot`, `runtime.sendMessage(forkId, { type: "exportSettings" })`) |
| A provider whose credentials Cloud Speech has saved keeps its entry, whatever its enable switch or verification says; favorites are always unioned; voice selection, prosody, and UI preferences are taken only when Cloud Speech has no provider with complete saved credentials (`configuredProviders` empty; a provider switched Off still counts) | `apps/extension/src/migrations/handoff/merge.ts` (`mergeSnapshot`), `apps/extension/tests/migrations/handoff/handoff.test.ts` |
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
| Summary | see below. AMO's current form caps name and summary at 70 characters combined (`mozilla/addons-server`, `src/olympia/devhub/forms.py`: `CombinedNameSummaryCleanMixin.MAX_LENGTH = 70`, used by `DescribeFormContentOptimization`), so with the 12-character name the summary gets at most 58 |
| Description | the section 1 description with two edits: drop the FORMERLY POLLY FOR CHROME paragraph, and drop the "Feedback > Leave a review" sentence until `FIREFOX_ADDON_SLUG` is set (the button is hidden on Firefox until then). The rest holds on Firefox as written: the shortcuts are the same, and the YOUR KEYS line says "browser account", which covers Firefox Sync |
| Categories | AMO has no Accessibility category. Pick `Language Support` (primary) and `Other` |
| Homepage | `https://vivswan.github.io/cloud-speech/` |
| Support website | `https://github.com/vivswan/cloud-speech/issues` |
| Support email | leave empty (issues are the support channel) |
| Privacy policy | AMO wants the text, not a URL: paste the text of `https://vivswan.github.io/cloud-speech/privacy/` (source `apps/web/src/pages/privacy.astro`) and put the URL on its first line |
| License | `Custom License`; paste `LICENSE.md` (Individual and Small Organization License 1.1.0) |
| Data collection | declared in the manifest (`data_collection_permissions.required`: `websiteContent`, `authenticationInfo`); if the form asks again, answer the same two, nothing optional |
| Source code submission | Yes, upload the sources zip. Notes for the reviewer: below |

**Summary** (57 of 58 chars; 69 of 70 with the name):

```text
Read highlighted text aloud with your own cloud TTS keys.
```

**Notes to the reviewer** (source code submission):

```text
Build instructions are in README.md. Install Bun at the version pinned in .bun-version, then run: bun install --frozen-lockfile && bun run --cwd apps/extension build:firefox. The zip appears in apps/extension/.output/ and rebuilds to the same contents from the same commit. The extension has no servers: the only network calls it makes are to the TTS providers the user gave credentials to (credential validation and a voice check on Save & test; a built-in sample sentence on voice preview; voice lists while enabled, where the list is not built in or typed by the user; the user's text to the one whose voice is selected; see apps/extension/src/providers/, src/lib/voices.ts, src/lib/probe.ts); Help and Feedback buttons open the website or a GitHub issue page in a new tab; once FIREFOX_ADDON_SLUG in packages/constants/src/index.ts names this listing, builds also show a button that opens its review page. Audio plays in the background event page (no offscreen API on Firefox; see apps/extension/src/lib/audio-host.ts).
```

**Pipeline** (`.github/workflows/update-release.yml`, "Publish to addons.mozilla.org" step):

1. The first submission is manual on the AMO Developer Hub (the listing must exist before the API can update it).
2. Set `FIREFOX_ADDON_SLUG` in `packages/constants/src/index.ts` to the slug you chose. That flips `firefoxListing` to `published`:
   - the website shows "Add to Firefox"
   - the extension shows its review button on Firefox
3. Add the repository secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` (API credentials from the Developer Hub) and `AMO_EXTENSION_ID` (`cloud-speech@vivswan.github.io`). Until they exist the step skips with a notice and the zips are only attached to the GitHub release.

## 4. How to update

| Field | Source | Where to change it |
| --- | --- | --- |
| Title (all stores) | manifest `name` | `EXTENSION_NAME` in `packages/constants/src/index.ts` |
| Summary (CWS) | manifest `description` | `extDescription` in `apps/extension/src/locales/en.yml` (and the other three locales) |
| Version | manifest `version` | root `package.json`, bumped by release-please |
| Permissions, host permissions, commands, default shortcuts | manifest | `apps/extension/wxt.config.ts` (`manifest`), shortcuts via `SHORTCUTS` in `packages/constants/src/index.ts` |
| Content script match pattern | manifest | `apps/extension/src/entrypoints/content.ts` |
| `activeTab` justification | manifest | Needed while the dashboard holds a package that declares it (1.0.6 and older): paste the block in section 1. The 2.x package drops the permission (`<all_urls>` already authorizes the `scripting.executeScript` selection read), so delete the entry after the first 2.x upload. |
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
