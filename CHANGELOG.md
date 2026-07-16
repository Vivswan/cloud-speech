# Changelog

## [2.0.0](https://github.com/Vivswan/cloud-speech/compare/v1.0.8...v2.0.0) (2026-07-16)


### ⚠ BREAKING CHANGES

* complete rewrite; legacy flat storage keys are migrated non-destructively to the new settings object on first run.

### Features

* add a display-language selector and localize the website into Hindi and Chinese ([ceafab0](https://github.com/Vivswan/cloud-speech/commit/ceafab0fd670d7b6cf2f924615928f43762d9750))
* add comprehensive Vitest test suite with 96% coverage ([c6c7718](https://github.com/Vivswan/cloud-speech/commit/c6c77180c3576c8f24fc5787a260898c56456755))
* add dark mode with a light/dark/system theme to the extension and website ([90a3bfc](https://github.com/Vivswan/cloud-speech/commit/90a3bfce168fe6bda76b0350ac2fee8990e2424f))
* fold store zips into builds, declare AMO data collection, extend lint gates ([a3f7649](https://github.com/Vivswan/cloud-speech/commit/a3f764980a7fb16f4479883e1fe7e195d26db8ff))
* **providers:** add OpenAI-compatible server provider ([82eb595](https://github.com/Vivswan/cloud-speech/commit/82eb5953883b8f3ee6e6801722b5e826feeddba4))
* rebuild as Cloud Speech for Chrome with multi-provider TTS ([3cda6cf](https://github.com/Vivswan/cloud-speech/commit/3cda6cfd4a2e4f0312585646c386c78af47bf0bf))
* rename to Cloud Speech, add Firefox support, and unify store builds ([89f1a4b](https://github.com/Vivswan/cloud-speech/commit/89f1a4bb0ffdfa198e2e6ebfe1d81502bbe8bf8e))
* validate credentials client-side and harden sync, reading, and picker flows ([674597a](https://github.com/Vivswan/cloud-speech/commit/674597a4eb3aa80e76f4c40a1be1df79168dcc6d))
* **web:** rework the extra-models guide around LiteLLM, fix dev-mode reset ([45f0f19](https://github.com/Vivswan/cloud-speech/commit/45f0f19f035e0e59a2cc23cb79007b3156ade653))


### Bug Fixes

* add type assertions for Chrome storage API ([09e41e6](https://github.com/Vivswan/cloud-speech/commit/09e41e626c437ff202b064cd346ec4d4b1d49447))
* avoid #i18n in the background module graph ([3f15c1c](https://github.com/Vivswan/cloud-speech/commit/3f15c1c6ef1de16f21098b683a1248dce4379232))
* correct TypeScript types in test files ([ae2c942](https://github.com/Vivswan/cloud-speech/commit/ae2c942a633640f78c3eab203a0cdff28c517524))
* **dev:** keep the web dev server foreground and stop it with the orchestrator ([60aa0dd](https://github.com/Vivswan/cloud-speech/commit/60aa0ddbffbfe59d7a58726b5dabc07d5e8a7d1a))
* ignore unused variables starting with underscore ([e1bc84d](https://github.com/Vivswan/cloud-speech/commit/e1bc84d58a2b70976b6c5649164b4decf33efbec))
* install missing @testing-library/react dependency ([116ff75](https://github.com/Vivswan/cloud-speech/commit/116ff75a6c38bc26946e49ca68ef367d1282c879))
* **popup:** drop the inline error text on unavailable voices ([398bd47](https://github.com/Vivswan/cloud-speech/commit/398bd475003f86497be35358daea7ec928039358))
* **providers:** reject transient custom-server failures instead of masking them ([a46f4ae](https://github.com/Vivswan/cloud-speech/commit/a46f4ae651b18bfe507564284f3c323510947722))
* resolve all ESLint errors and update pre-commit hook ([1d6f98e](https://github.com/Vivswan/cloud-speech/commit/1d6f98e9987cae73cf5b429e09b2974f2fcd99e2))
* resolve CodeQL alerts in tag stripping and dev shell commands ([9109d68](https://github.com/Vivswan/cloud-speech/commit/9109d681deef5e883898683faf17fa7cf236b461))
* **settings:** only claim previous credentials were kept when some existed ([b69e76f](https://github.com/Vivswan/cloud-speech/commit/b69e76fe2a0b3c6ccf756e33fb988852a8b46319))
