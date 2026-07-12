# Security Policy

## Supported versions

Only the latest release of each Chrome Web Store listing (Cloud Speech for Chrome,
Polly for Chrome, Azure Speech for Chrome) is supported. All three ship from this
repository at the same version.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/vivswan/cloud-speech-for-chrome/security/advisories/new)
("Report a vulnerability"). Include reproduction steps and the extension version.
You'll get an acknowledgement as soon as possible, and a fix ships in the next
release once confirmed.

## Scope notes for researchers

- The extension stores **user-provided API credentials** (AWS, Azure, Google,
  OpenAI) in `chrome.storage` — `sync` by default, `local` when the user turns
  the sync toggle off. Anything that exfiltrates, logs, or leaks these
  credentials is in scope and high severity.
- Selected page text is sent **only** to the TTS provider the user configured,
  directly from the browser. There are no intermediary servers, no analytics,
  and no telemetry — any network destination other than the four providers'
  official endpoints is a bug.
- The content script runs on all pages (`<all_urls>`) to read selections and
  show error toasts. Injection or privilege-escalation findings there are in
  scope.
- Never include real credentials in a report; redact everything that looks like
  a key.
