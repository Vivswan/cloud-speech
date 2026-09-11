
## Scope notes for researchers

One Chrome build is published to both Chrome Web Store listing IDs (Cloud Speech, formerly Polly for Chrome, and the legacy Azure Speech for Chrome listing), and a Firefox build ships to addons.mozilla.org, all from the same source at the same version; a report against any listing applies to all of them.

- The extension stores user-provided API credentials (AWS, Azure, Google, OpenAI) in `chrome.storage`: `sync` by default, `local` when the user turns the sync toggle off. Anything that exfiltrates, logs, or leaks these credentials is in scope and high severity.
- Selected page text is sent only to the TTS provider the user configured, directly from the browser, with no intermediary servers or analytics. Any destination for that text other than the four providers' official endpoints is a bug.
- The content script runs on all pages (`<all_urls>`) to show error toasts; selected text is read on demand via `scripting.executeScript`. Injection or privilege-escalation findings in either path are in scope.
