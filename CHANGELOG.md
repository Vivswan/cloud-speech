# Changelog

## [2.0.0](https://github.com/Vivswan/cloud-speech-for-chrome/compare/v1.0.8...v2.0.0) (2026-07-13)


### ⚠ BREAKING CHANGES

* complete rewrite; legacy flat storage keys are migrated non-destructively to the new settings object on first run.

### Features

* add comprehensive Vitest test suite with 96% coverage ([eda9948](https://github.com/Vivswan/cloud-speech-for-chrome/commit/eda9948d3aa0bdaf311305fff1d7c998875500a8))
* **providers:** add OpenAI-compatible server provider ([e4c8081](https://github.com/Vivswan/cloud-speech-for-chrome/commit/e4c8081d2571c998f2ba91ec8d5945db56316526))
* rebuild as Cloud Speech for Chrome with multi-provider TTS ([24dcf0e](https://github.com/Vivswan/cloud-speech-for-chrome/commit/24dcf0ee4933f482652f036d97d036051df8b701))
* **web:** rework the extra-models guide around LiteLLM, fix dev-mode reset ([30b39df](https://github.com/Vivswan/cloud-speech-for-chrome/commit/30b39dfa65ab6eec4c87238afe21a25c78a7407c))


### Bug Fixes

* add type assertions for Chrome storage API ([aa81788](https://github.com/Vivswan/cloud-speech-for-chrome/commit/aa81788cf88553fad3668e71bdbda9af34bdf137))
* avoid #i18n in the background module graph ([eda81ca](https://github.com/Vivswan/cloud-speech-for-chrome/commit/eda81ca8d15c3d5ca3844cd97d4acbd8734d72c3))
* correct TypeScript types in test files ([66be267](https://github.com/Vivswan/cloud-speech-for-chrome/commit/66be26793bbebcd40d3ecbc09eba4d90bcc4856a))
* ignore unused variables starting with underscore ([3f831e2](https://github.com/Vivswan/cloud-speech-for-chrome/commit/3f831e23e30662fee087a6cdd0b5d962d46a4a8c))
* install missing @testing-library/react dependency ([b004795](https://github.com/Vivswan/cloud-speech-for-chrome/commit/b004795e14fff0f0f5c3072c715a4fa631b9d37a))
* **providers:** reject transient custom-server failures instead of masking them ([8cc44e7](https://github.com/Vivswan/cloud-speech-for-chrome/commit/8cc44e7c6f2e926de57c28bd5c5fce8c91acdf47))
* resolve all ESLint errors and update pre-commit hook ([ec47183](https://github.com/Vivswan/cloud-speech-for-chrome/commit/ec47183aa41379745ce32c6e0bef4da643703881))
* resolve CodeQL alerts in tag stripping and dev shell commands ([14e653d](https://github.com/Vivswan/cloud-speech-for-chrome/commit/14e653d31cc8b63701ee33a1abdba5c75c0d85f8))
