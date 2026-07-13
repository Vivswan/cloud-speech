# Security policy

## Supported versions

Only the latest release is supported. One build is published to all three Chrome
Web Store listing IDs (the unified Cloud Speech listing plus the two
original fork listings) and to addons.mozilla.org, all at the same version.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/vivswan/cloud-speech/security/advisories/new)
("Report a vulnerability"). Include reproduction steps and the extension version.
You'll get an acknowledgement as soon as possible, and a fix ships in the next
release once confirmed.

## Scope notes for researchers

- The extension stores user-provided API credentials (AWS, Azure, Google,
  OpenAI) in `chrome.storage`: `sync` by default, `local` when the user turns
  the sync toggle off. Anything that exfiltrates, logs, or leaks these
  credentials is in scope and high severity.
- Selected page text is sent only to the TTS provider the user configured,
  directly from the browser, with no intermediary servers or analytics. Any
  destination for that text other than the four providers' official endpoints
  is a bug.
- The content script runs on all pages (`<all_urls>`) to show error toasts;
  selected text is read on demand via `scripting.executeScript`. Injection or
  privilege-escalation findings in either path are in scope.
- Never include real credentials in a report; redact everything that looks like
  a key.
