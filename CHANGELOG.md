# Changelog

## [2.0.1](https://github.com/Vivswan/cloud-speech/compare/v2.0.0...v2.0.1) (2026-09-13)


### Features

* render the store screenshots in every extension locale ([#204](https://github.com/Vivswan/cloud-speech/issues/204)) ([1333cee](https://github.com/Vivswan/cloud-speech/commit/1333cee344bbe0c8cafdff356d5af384c6b6916b))
* run on Firefox for Android without the context menu and shortcut APIs ([#203](https://github.com/Vivswan/cloud-speech/issues/203)) ([e75b289](https://github.com/Vivswan/cloud-speech/commit/e75b289907a2372356d105b9c4e9d8343626f83d))


### Bug Fixes

* drop the 404 page's canonical and fail the web build on a same-site link that resolves to nothing ([#207](https://github.com/Vivswan/cloud-speech/issues/207)) ([7dc0394](https://github.com/Vivswan/cloud-speech/commit/7dc03944a9f579ca97ae1d4a776cffa43bf056f9))
* satisfy the AMO validator's manifest and content-script warnings ([#197](https://github.com/Vivswan/cloud-speech/issues/197)) ([83944c8](https://github.com/Vivswan/cloud-speech/commit/83944c84cfb027063f9073cff2a24cb4b4d90fb2))

## [2.0.0](https://github.com/Vivswan/cloud-speech/compare/v1.0.6...v2.0.0) (2026-09-09)


### ⚠ BREAKING CHANGES

* complete rewrite; legacy flat storage keys are migrated non-destructively to the new settings object on first run.

### Features

* add a display-language selector and localize the website into Hindi and Chinese ([2339a37](https://github.com/Vivswan/cloud-speech/commit/2339a37e363221cb83403a17101378bad5e7e24e))
* add comprehensive Vitest test suite with 96% coverage ([b06a4d1](https://github.com/Vivswan/cloud-speech/commit/b06a4d174befe14bd6eaf974b488e7bebbbec666))
* Add cooldown configuration for package ecosystems ([6282e7e](https://github.com/Vivswan/cloud-speech/commit/6282e7edec7030393252997828a65dc9d474b469))
* add dark mode with a light/dark/system theme to the extension and website ([f94581c](https://github.com/Vivswan/cloud-speech/commit/f94581c67219f05d1fcfc238398a6848bef62729))
* Add repository line ending and symlink normalization ([0aee32a](https://github.com/Vivswan/cloud-speech/commit/0aee32a761e30780048214b596cfe25d6d2e04ad))
* add the playback document with an epoch compare-and-swap store ([#133](https://github.com/Vivswan/cloud-speech/issues/133)) ([91eab81](https://github.com/Vivswan/cloud-speech/commit/91eab81fb3759647d3ac8aa8b6c349a6d7c8d3de))
* cancel superseded provider calls, move Azure to REST, retry transient failures ([#141](https://github.com/Vivswan/cloud-speech/issues/141)) ([0abbce3](https://github.com/Vivswan/cloud-speech/commit/0abbce3ee028ce7f60bed877e931d6a729077623))
* complete the fork-listing settings handoff ([#137](https://github.com/Vivswan/cloud-speech/issues/137)) ([3129993](https://github.com/Vivswan/cloud-speech/commit/3129993deb0eb2d865baf800fab0ffd5b6facf76))
* fold store zips into builds, declare AMO data collection, extend lint gates ([5140580](https://github.com/Vivswan/cloud-speech/commit/5140580090cd471516ad05aec7c1bf5f7ba1b71f))
* per-provider settings with an atomic voice selection (schema v2) ([#143](https://github.com/Vivswan/cloud-speech/issues/143)) ([37cfc2b](https://github.com/Vivswan/cloud-speech/commit/37cfc2bc4b078126806632ecd1a0aa451de24357))
* **providers:** add OpenAI-compatible server provider ([2a6460f](https://github.com/Vivswan/cloud-speech/commit/2a6460f9f2d65765ecc0b996b77cbd61ebae089b))
* publish the unified listing under the Polly store id ([#132](https://github.com/Vivswan/cloud-speech/issues/132)) ([c38cc48](https://github.com/Vivswan/cloud-speech/commit/c38cc48890743d3ca6f92fdfe1a4fdbd9f5dcff9))
* rebuild as Cloud Speech for Chrome with multi-provider TTS ([a66c6a2](https://github.com/Vivswan/cloud-speech/commit/a66c6a27ed0038f39937ef0d7c8fc84003a9f5aa))
* recolor the speech-bubble icon to the sunset palette ([#171](https://github.com/Vivswan/cloud-speech/issues/171)) ([79fc592](https://github.com/Vivswan/cloud-speech/commit/79fc59281ad7d8e1cf10916fbe23ed22ad6b1074))
* rename to Cloud Speech, add Firefox support, and unify store builds ([4db3036](https://github.com/Vivswan/cloud-speech/commit/4db3036e9e55e24e4258503306eefc66b64d0e0e))
* **settings:** add Backup section with export, import, and restore ([563f353](https://github.com/Vivswan/cloud-speech/commit/563f353f55eb6ee2481987faac2407dfa7beabbe))
* **settings:** add settings transfer module and import backup storage ([c774de2](https://github.com/Vivswan/cloud-speech/commit/c774de2a20db93e8ac2cd90b3c59be76a8eb0edd))
* ship Manrope in the extension and the website so every OS and screenshot shows one typeface ([#188](https://github.com/Vivswan/cloud-speech/issues/188)) ([641ed74](https://github.com/Vivswan/cloud-speech/commit/641ed745c00e07c783bee93f3affb7fce9fe158e))
* switch the bundled typeface from Manrope to Inter ([#193](https://github.com/Vivswan/cloud-speech/issues/193)) ([751e204](https://github.com/Vivswan/cloud-speech/commit/751e20427ae86bc7dcdc3ecf5f0430dc0bcd87e8))
* validate credentials client-side and harden sync, reading, and picker flows ([1c1ab1f](https://github.com/Vivswan/cloud-speech/commit/1c1ab1fbcda1d05456c49a57fcb4554160c6bd31))
* **web:** add a walkthrough page with zoomable store screenshots ([#186](https://github.com/Vivswan/cloud-speech/issues/186)) ([ea9cefc](https://github.com/Vivswan/cloud-speech/commit/ea9cefc18a3549e174ca0dea27fb6bb03184af89))
* **web:** rework the extra-models guide around LiteLLM, fix dev-mode reset ([2fa7658](https://github.com/Vivswan/cloud-speech/commit/2fa7658e7ad664e6b33fc4035b9ae69f14d14ea1))


### Bug Fixes

* add type assertions for Chrome storage API ([a0df820](https://github.com/Vivswan/cloud-speech/commit/a0df820a4e623cea5b0849203436ef669a299cfd))
* answer a settings export only after the startup conversion has written the blob ([#148](https://github.com/Vivswan/cloud-speech/issues/148)) ([ec993fe](https://github.com/Vivswan/cloud-speech/commit/ec993fe5de42635024f833489de335a548fcd63e))
* avoid #i18n in the background module graph ([5c37e50](https://github.com/Vivswan/cloud-speech/commit/5c37e5066c73234f9c61696b415a7a7a49e3b316))
* correct TypeScript types in test files ([ed80cea](https://github.com/Vivswan/cloud-speech/commit/ed80cea89eceb42483be1e1a37b1834cdb452dbb))
* describe what each feedback button prefills after the field change ([#167](https://github.com/Vivswan/cloud-speech/issues/167)) ([3f6bdda](https://github.com/Vivswan/cloud-speech/commit/3f6bdda9236921ca69e8711f38189a4ace8465e1))
* **dev:** install dependencies when bun.lock is newer than the last install and name the missing font package ([#192](https://github.com/Vivswan/cloud-speech/issues/192)) ([c59210b](https://github.com/Vivswan/cloud-speech/commit/c59210bc484434fd42c4f81b2e3ace37892aef54))
* **dev:** keep the web dev server foreground and stop it with the orchestrator ([d5e3556](https://github.com/Vivswan/cloud-speech/commit/d5e35561c99b604db87aa7abea885d53e190399c))
* drop code_quality ruleset rule the rulesets API rejects ([a16ed5b](https://github.com/Vivswan/cloud-speech/commit/a16ed5bef9f539d0a155dfae5721c810dfe813c8))
* drop the redundant activeTab permission ([#165](https://github.com/Vivswan/cloud-speech/issues/165)) ([e5c8ee2](https://github.com/Vivswan/cloud-speech/commit/e5c8ee2036220fd87d18e13dc61d2d9898d84cab))
* **e2e:** call the shared wait helpers with their current signatures in the host-permission step ([#166](https://github.com/Vivswan/cloud-speech/issues/166)) ([53dc67e](https://github.com/Vivswan/cloud-speech/commit/53dc67e1054571ae63f27e54c7333ba1e17f542b))
* explain provider failures in plain words and auto-dismiss the error banner ([#175](https://github.com/Vivswan/cloud-speech/issues/175)) ([41f75d6](https://github.com/Vivswan/cloud-speech/commit/41f75d69e2e0969640a37e2f6ba3abe011985893))
* extract the theme init script without a tag regex ([db2a05f](https://github.com/Vivswan/cloud-speech/commit/db2a05f46c03daaef4f450fab1e4e01fd490899e))
* Fix Icon entry in gitignore ([b3bbad7](https://github.com/Vivswan/cloud-speech/commit/b3bbad7a4806115594df1ebc2e6fcd4ee5104969))
* gate merges on CodeQL warnings as well as errors ([0bd7f24](https://github.com/Vivswan/cloud-speech/commit/0bd7f246202832faaac658ad75ef333a29fec55f))
* handle string suggested_key in shortcut fallback ([5575272](https://github.com/Vivswan/cloud-speech/commit/5575272231d321532f310b38e3b8cad8ae56cfc6))
* hide store links until listings are published ([79c8832](https://github.com/Vivswan/cloud-speech/commit/79c88328f710f1ec6c953ba4ad82859f0c79181d))
* ignore unused variables starting with underscore ([cfc9a59](https://github.com/Vivswan/cloud-speech/commit/cfc9a5923059a2252c47c32b80aced9b2e7a3520))
* install missing @testing-library/react dependency ([9f99b19](https://github.com/Vivswan/cloud-speech/commit/9f99b19105cd6b563d63aea24c3c498f3558043f))
* install web-ext so the dev runner honors the webExt config ([#142](https://github.com/Vivswan/cloud-speech/issues/142)) ([f76ed2b](https://github.com/Vivswan/cloud-speech/commit/f76ed2b6cbbe04ab324f0376cc99aad8b2901fa0))
* keep the selected voice when only its provider's voice fetch fails ([#179](https://github.com/Vivswan/cloud-speech/issues/179)) ([15a6037](https://github.com/Vivswan/cloud-speech/commit/15a6037b79e094166c3ec7220b2ffcf02568efab))
* make the audio element the owner of playback and preview state ([b47ccab](https://github.com/Vivswan/cloud-speech/commit/b47ccab5f8b2b58ac096f1ae3e02c8156c53f8c3))
* never auto-select a voice the availability scan flagged ([#172](https://github.com/Vivswan/cloud-speech/issues/172)) ([4f2204f](https://github.com/Vivswan/cloud-speech/commit/4f2204fb7533c8c446cb2a9ab50c314fd68cd2b3))
* never cut an SSML chunk inside an XML entity ([#178](https://github.com/Vivswan/cloud-speech/issues/178)) ([d238e65](https://github.com/Vivswan/cloud-speech/commit/d238e6543eb03648d7650b612255b2c1f69d90ee))
* **popup:** drop the inline error text on unavailable voices ([527d7f1](https://github.com/Vivswan/cloud-speech/commit/527d7f184fe8b431e5ff569cabe85371515d29f4))
* prefill the bug report's environment field from the Feedback view ([#164](https://github.com/Vivswan/cloud-speech/issues/164)) ([5f89573](https://github.com/Vivswan/cloud-speech/commit/5f89573bcdf3f7082f39c2d7df6a116ff1cac9a4))
* **providers:** reject transient custom-server failures instead of masking them ([5c81b33](https://github.com/Vivswan/cloud-speech/commit/5c81b3300da39abe3893d2cd9bf8f2fd6346e5e1))
* reject a synthesis response that carries no audio instead of playing silence ([#181](https://github.com/Vivswan/cloud-speech/issues/181)) ([11e20f0](https://github.com/Vivswan/cloud-speech/commit/11e20f0671895a3e947dfe0e13f8d6d35ff6876d))
* resolve all ESLint errors and update pre-commit hook ([6d4f759](https://github.com/Vivswan/cloud-speech/commit/6d4f7590dbde2854312f1384d6d2f31530e49877))
* resolve CodeQL alerts in tag stripping and dev shell commands ([be162e1](https://github.com/Vivswan/cloud-speech/commit/be162e1c15872b52b3c9c5ba47d5f3669d44cb2a))
* **settings:** only claim previous credentials were kept when some existed ([51ef402](https://github.com/Vivswan/cloud-speech/commit/51ef402d5e6f89e06c14aadabca1164d808ff270))
* show the kept selection, not "No voices yet", while its provider is unreachable ([#182](https://github.com/Vivswan/cloud-speech/issues/182)) ([5eb26b4](https://github.com/Vivswan/cloud-speech/commit/5eb26b42fc172ef3bdc8f87a8bf24f4621a4250c))
* silence the WXT sources-zip stat warnings on the Firefox build ([#140](https://github.com/Vivswan/cloud-speech/issues/140)) ([ba38205](https://github.com/Vivswan/cloud-speech/commit/ba38205fa84bf12bc599a1f8553ebd937ee5a250))
* **web:** make the privacy policy match the five providers and self-hosted http servers ([#163](https://github.com/Vivswan/cloud-speech/issues/163)) ([d64f955](https://github.com/Vivswan/cloud-speech/commit/d64f95535779eb2c7ea4ff4474782cfce924cec3))
* **web:** noindex and skip the sitemap on the latest and versioned Pages tiers ([#158](https://github.com/Vivswan/cloud-speech/issues/158)) ([a4bcd41](https://github.com/Vivswan/cloud-speech/commit/a4bcd41e851d76737eb5353543b562b9755e63e8))
