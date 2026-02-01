# Polly For Chrome

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/kdcbeehimalgmeoeajnflggejlemclnn.svg)](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn)
[![GitHub Pages](https://img.shields.io/badge/website-polly--for--chrome-blue)](https://vivswan.github.io/polly-for-chrome/)
[![GitHub](https://img.shields.io/github/license/vivswan/polly-for-chrome)](LICENSE)

A premium Chrome extension that transforms any text on the web into high-quality, natural-sounding speech using Amazon
Polly's advanced AI voices. Support for 40+ languages and hundreds of professional voices with multilingual interface
support.

**[Visit Website](https://vivswan.github.io/polly-for-chrome/)** | *
*[Chrome Web Store](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn)**

## Key Features

* **40+ Languages & Hundreds of Voices** - Choose from Standard, Neural, Generative, and Long-form voice engines
* **Multi-Language Interface** - Available in English, Chinese (Simplified & Traditional), and Hindi
* **Multiple Speed Options** - Context menu with 1x, 1.5x, and 2x playback speeds
* **Smart Text Processing** - Automatically sanitizes HTML content using sanitize-html library
* **Keyboard Shortcuts** - Quick access with Ctrl+Shift+S (read aloud) and Ctrl+Shift+E (download)
* **Audio Downloads** - Save as high-quality MP3 files for offline use
* **SSML Support** - Advanced markup for precise speech control
* **Secure & Private** - Your AWS credentials stay local and private

## Quick Start

1. **Install Extension**: Add
   from [Chrome Web Store](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn)
2. **Setup AWS**: Create AWS account and configure Polly
   access ([detailed guide](https://vivswan.github.io/polly-for-chrome/#install))
3. **Start Converting**: Highlight any text, right-click, and choose your preferred speed

## Pricing

- **Extension**: Completely FREE
- **AWS Free Tier**: 5 million characters per month for 12 months
- **Standard voices**: $4 per million characters
- **Neural voices**: $16 per million characters
- **Generative voices**: $30 per million characters

[View detailed pricing →](https://aws.amazon.com/polly/pricing/)

## AWS Setup

### Quick Setup

1. Create an AWS account at [aws.amazon.com](https://aws.amazon.com)
2. Go to IAM service and create a new user
3. Attach the `AmazonPollyReadOnlyAccess` policy
4. Generate access keys for the user
5. Enter credentials in the extension settings

For detailed setup instructions with screenshots, visit our [help guide](https://vivswan.github.io/polly-for-chrome/).

## Development

### Prerequisites

This project uses [Bun](https://bun.sh) as the package manager and runtime. Install it globally:

```bash
curl -fsSL https://bun.sh/install | bash
```

### Extension Development

```bash
bun install
bun run build
```

Load the unpacked extension from the `dist` folder.

### Website Development

```bash
bun install
bun run build
```

Website files are generated in the `dist` folder and deployed to GitHub Pages.

### Available Scripts

- `bun run build` - Build Chrome extension and website
- `bun run dev` - Development mode with file watching
- `bun run lint` - Run ESLint
- `bun run typecheck` - Run TypeScript type checking
- `bun run test` - Run tests
- `bun run validate-translations` - Validate translation files consistency
- `bun run generate-icons` - Generate extension icons
- `bun run bump-version` - Bump version number

### Pre-commit Hooks

The project uses Husky for Git hooks. Pre-commit hooks automatically:
- Install dependencies if needed
- Format code with Prettier via lint-staged
- Run ESLint checks
- Run tests

Hooks are automatically installed when you run `bun install`.

## Project Structure

```
├── src/
│   ├── components/          # React components
│   ├── helpers/            # Utility functions
│   ├── localization/       # Translation files and system
│   │   ├── en.yaml         # English translations
│   │   ├── zh-CN.yaml      # Chinese Simplified translations
│   │   ├── zh-TW.yaml      # Chinese Traditional translations
│   │   ├── hi.yaml         # Hindi translations
│   │   └── translation.ts  # Translation infrastructure
│   ├── assets/             # Images, CSS, HTML files
│   │   └── images/
│   │       └── screenshots/ # Website screenshots
│   ├── index.ts           # Website homepage
│   ├── popup.tsx           # Extension popup
│   ├── help.tsx            # Help page
│   └── changelog.tsx       # Changelog page
├── dist/                   # Built extension files
├── scripts/                # Build scripts
└── .github/workflows/      # GitHub Actions
```

## CI/CD

### GitHub Actions Workflows

- **CI** (`ci.yml`) - Runs on all pushes and PRs
  - Linting and type checking
  - Format checking with Prettier
  - Test execution
  - Build verification

- **Auto Format** (`auto-format.yml`) - Automatically formats code when PR is labeled with `fix-lint`

- **Deploy** (`deploy.yml`) - Deploys on push to `deploy` branch
  - Runs full test suite
  - Builds extension (.zip and .crx)
  - Creates GitHub release
  - Deploys website to GitHub Pages
  - Auto-bumps version for next release

### Website

The project includes a marketing website built with React and Tailwind CSS:

- **URL**: [https://vivswan.github.io/polly-for-chrome/](https://vivswan.github.io/polly-for-chrome/)
- **Auto-deployed** via GitHub Actions on every push to `deploy` branch
- **Build command**: `bun run build`

## Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to
discuss what you would like to change.

### Development Workflow

1. Fork the repository
2. Clone and install dependencies:
   ```bash
   git clone https://github.com/YOUR_USERNAME/polly-for-chrome.git
   cd polly-for-chrome
   bun install
   ```
3. Create your feature branch (`git checkout -b feature/AmazingFeature`)
4. Make your changes and ensure tests pass:
   ```bash
   bun run lint
   bun run typecheck
   bun run test
   bun run build
   ```
5. Commit your changes (pre-commit hooks will run automatically)
6. Push to the branch (`git push origin feature/AmazingFeature`)
7. Open a Pull Request

### Code Quality

- Pre-commit hooks automatically format and lint your code
- If you need to bypass hooks (not recommended): `HUSKY=0 git commit -m "message"`
- To auto-format a PR, add the `fix-lint` label

## License

This project is based on [Wavenet for Chrome](https://github.com/pgmichael/wavenet-for-chrome) and licensed under
the [MIT License](LICENSE).

## Links

- **Website**: [https://vivswan.github.io/polly-for-chrome/](https://vivswan.github.io/polly-for-chrome/)
- **Chrome Web Store**: [Install Extension](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn)
- **Issues**: [Report Bugs](https://github.com/vivswan/polly-for-chrome/issues)
- **AWS Polly Docs**: [Documentation](https://docs.aws.amazon.com/polly/)

---

**Star this repository if you find it helpful!**
