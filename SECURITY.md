# Security policy

## Supported versions

Only the latest release is supported.

## Reporting a vulnerability

**Do not open a public issue for security problems.**

Report vulnerabilities privately via
[GitHub Security Advisories](https://github.com/vivswan/cloud-speech/security/advisories/new)
("Report a vulnerability"). If that page is unavailable (GitHub offers no
advisories on private personal repositories), contact
[@Vivswan](https://github.com/vivswan)
directly instead. A useful report includes:

- what an attacker can do (impact), and where trust is broken,
- reproduction steps or a proof of concept,
- the affected version or commit.

Expect an acknowledgement within a few days, and a fix in the next release
once the report is confirmed. Please allow reasonable time for that fix
before any public disclosure.

Never include real credentials in a report; redact everything that looks like
a key.

<!-- Repository-specific security documentation (scope, threat model, review
     expectations for security-relevant changes) goes below this line. It
     survives template updates via three-way merge. -->
<!-- repo-platform:local-section -->

## Scope notes for researchers

One build is published to all three Chrome Web Store listing IDs (the unified
Cloud Speech listing plus the two original fork listings) and to
addons.mozilla.org, all at the same version; a report against any listing
applies to all of them.

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
