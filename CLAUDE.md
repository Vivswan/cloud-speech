# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Polly for Chrome is a Chrome extension that converts text to speech using Amazon Polly. It supports 40+ languages with
multiple voice engines (Standard, Neural, Generative, Long-form) and includes a multilingual interface (English, Chinese
Simplified/Traditional, Hindi).

## Build System & Development Commands

This project uses **Bun** as the package manager and runtime (not npm/yarn/pnpm).

### Essential Commands

```bash
# Install dependencies
bun install

# Build extension for production (outputs to dist/)
bun run build

# Development mode with file watching
bun run dev

# Linting
bun run lint

# Type checking (both main and test files)
bun run typecheck

# Testing
bun run test              # Watch mode
bun run test:run          # Run once
bun run test:ui           # UI mode
bun run test:coverage     # Generate coverage report

# Utility scripts
bun run validate-translations   # Validate YAML translation files
bun run generate-icons         # Generate icon sizes from SVG
bun run bump-version          # Bump version in package.json and manifest
```

### Loading the Extension Locally

After running `bun run build`, load the unpacked extension from the `dist/` folder in Chrome via
`chrome://extensions/` (enable Developer mode).

## Architecture

### Chrome Extension Components (Manifest V3)

The extension follows Chrome's Manifest V3 architecture with these key components:

1. **Service Worker** (`src/service-worker.ts`)
    - Entry point for background processing
    - Bootstraps the extension and registers all event listeners
    - Manages extension lifecycle

2. **Background Scripts** (`src/background/`)
    - **bootstrap.ts**: Initializes extension (migrates storage, fetches voices, creates context menus)
    - **state.ts**: Global state management for audio queue, playback status, and cancellation tokens
    - **handlers/**: Core business logic for reading aloud, synthesis, downloading, and voice fetching
    - **listeners/**: Chrome API event handlers (context menu, commands, messages, storage changes)
    - **utils/**: Helper utilities for messaging, storage, context menus, and offscreen document management

3. **Offscreen Document** (`src/offscreen.ts`)
    - Required for audio playback in Manifest V3 (service workers can't play audio directly)
    - Receives audio URIs via messaging and plays them using HTML5 Audio element
    - Handles play/stop commands from the service worker

4. **Content Script** (`src/content-script.tsx`)
    - Injected into all web pages
    - Captures text selection for read-aloud functionality
    - Communicates with background script via Chrome messaging API

5. **Popup UI** (`src/popup.tsx`)
    - Main settings interface (React + Tailwind CSS)
    - Manages AWS credentials, voice selection, playback settings
    - Uses React hooks for state management

### Text Processing Pipeline

Text is processed through this pipeline before synthesis:

1. **Text Sanitization** (`src/helpers/text-helpers.ts`)
    - `sanitizeTextForSSML()`: Strips HTML tags using `sanitize-html` library, decodes HTML entities, escapes XML
      special characters
    - Preserves SSML if text is already wrapped in `<speak>` tags

2. **Chunking** (String prototype extensions)
    - `String.prototype.chunk()`: Splits text into sentences using `wink-nlp` for NLP processing
    - `String.prototype.chunkSSML()`: Splits SSML into 5000-character chunks while preserving tags
    - `String.prototype.isSSML()`: Detects if text is already SSML

3. **Synthesis** (`src/background/handlers/synthesis.ts`)
    - Applies prosody attributes (speed, pitch, volume) to text/SSML
    - Uses AWS SDK `@aws-sdk/client-polly` to synthesize speech
    - Converts audio stream to base64-encoded data URI
    - Processes audio bytes in chunks (8192 bytes) to avoid call stack overflow

### Translation System

The extension uses a custom YAML-based translation system (`src/localization/`):

- **translation.ts**: Global state management for locale switching
- **useTranslation()** hook: React hook for accessing translations with `t(key, params)` function
- Translation files: `en.yaml`, `zh-CN.yaml`, `zh-TW.yaml`, `hi.yaml`
- **validate-translations.cjs** script enforces consistency across all language files

### Build Pipeline

Custom build system in `scripts/bun.config.js`:

1. **Icon Generation**: Converts SVG to multiple PNG sizes (16, 19, 38, 48, 128, 1000px)
2. **Manifest Processing**: Updates version from package.json
3. **CSS Processing**: Runs Tailwind CSS via PostCSS
4. **TypeScript Compilation**: Uses Bun.build with custom plugins:
    - **react-compiler plugin**: Babel plugin for React compilation with React Compiler (annotation mode)
    - **yaml-loader plugin**: Loads YAML files as JS objects
5. **Asset Copying**: Copies HTML files, images, and YAML files to dist/
6. **Package Creation**: Generates `.zip` and `.crx` (if private key exists) in `builds/` folder

Entry points auto-discovered:

- Fixed: `popup.tsx`, `service-worker.ts`, `content-script.tsx`, `help.tsx`, `offscreen.ts`
- Auto-discovered: All `.ts`/`.tsx` files in `src/assets/js/` (output to `dist/js/`)

### State Management

The extension uses different state management approaches:

1. **Background State** (`src/background/state.ts`): Module-level state for queue management and playback status
2. **Chrome Storage**: Sync storage for user settings (AWS credentials, preferences)
3. **React Hooks**: Local state management in UI components
    - `useSync`: Syncs with Chrome sync storage
    - `useSession`: Syncs with Chrome session storage
    - `useLocalStorage`: Syncs with localStorage
    - `useDebounce`: Debounces values
    - `useMount`: Runs effect only on mount
    - `useOutsideClick`: Detects clicks outside element

### Testing

Tests use Vitest with Happy DOM environment:

- **Setup**: `tests/setup.ts` configures global test environment
- **Coverage**: Minimum 60% threshold for lines, functions, branches, statements
- **Component Tests**: Use `@testing-library/react` for React component testing
- **Hook Tests**: Test custom React hooks in isolation
- **Helper Tests**: Test utility functions (text processing, file handling)

## Important Implementation Details

### AWS SDK Usage

- Uses `@aws-sdk/client-polly` v3 (modular SDK)
- Credentials stored in Chrome sync storage (never in code)
- Supports all Polly output formats: MP3, OGG_OPUS
- Supports all engines: STANDARD, NEURAL, GENERATIVE, LONG_FORM

### Text Chunking Strategy

Amazon Polly has character limits per request, so text is chunked:

- **Plain text**: Split by sentences using wink-nlp
- **SSML**: 5000-character chunks while preserving tag structure
- Multiple chunks are synthesized in parallel then concatenated

### Audio Playback in Manifest V3

Service workers cannot play audio directly. Solution:

1. Create offscreen document (`offscreen.html`)
2. Service worker sends audio URI to offscreen document via messaging
3. Offscreen document plays audio using HTML5 Audio element
4. Offscreen document reports playback events back to service worker

### File Structure Conventions

- React components in `src/components/`
- Helper utilities in `src/helpers/`
- Custom hooks in `src/hooks/`
- Background logic in `src/background/`
- Type definitions in `src/types/`
- Assets in `src/assets/` (html, css, images, js)
- Tests mirror source structure in `tests/`

### Pre-commit Hooks

Husky runs these checks before commits:

1. Prettier formatting (auto-fixes)
2. ESLint checks (auto-fixes)
3. Test execution

To bypass: `HUSKY=0 git commit -m "message"` (not recommended)

### Git Workflow

**Important**: Do not add co-author attributions or "generated by" messages in commits or pull requests. All commits and
PRs should be clean without AI attribution footers like "Co-Authored-By: Claude" or "Generated with Claude Code".

## Common Development Tasks

### Adding a New Translation Key

1. Add key to all YAML files (`src/localization/*.yaml`)
2. Run `bun run validate-translations` to ensure consistency
3. Use in components: `const { t } = useTranslation(); t('your.key')`

### Testing with Real AWS Credentials

1. Create `.env.local` file (gitignored) with AWS credentials
2. Load extension in Chrome
3. Enter credentials in popup settings
4. Credentials are stored in Chrome sync storage

### Adding a New Voice Engine

1. Update `synthesize()` in `src/background/handlers/synthesis.ts`
2. Add engine mapping to `engineMap` object
3. Update UI dropdown in `src/components/views/Settings.tsx`

### Modifying Context Menu Items

Context menus are created in `src/background/utils/context-menus.ts` and localized based on Chrome's UI language.

### Running Single Test File

```bash
bun run test tests/path/to/file.test.ts
```

## CI/CD

GitHub Actions workflows:

- **CI** (`.github/workflows/ci.yml`): Runs on all pushes/PRs (lint, typecheck, tests, build)
- **Deploy** (`.github/workflows/deploy.yml`): Runs on push to `deploy` branch (creates release, deploys website)
- **Auto Format** (`.github/workflows/auto-format.yml`): Auto-formats code when PR labeled with `fix-lint`

## TypeScript Configuration

- Path alias: `@/*` maps to `src/*`
- Strict mode disabled for flexibility
- JSX transform: `react-jsx` (automatic runtime)
- Includes Chrome types via `@types/chrome`

## Extension Packaging

After build, two files are created in `builds/`:

1. **polly-for-chrome-vX.X.X.zip**: For Chrome Web Store upload
2. **polly-for-chrome-vX.X.X.crx**: For direct installation (requires `key.pem`)

Generate private key: `openssl genrsa -out key.pem 2048`
