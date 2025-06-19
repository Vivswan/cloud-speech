# Polly For Chrome

[![Chrome Web Store](https://img.shields.io/chrome-web-store/v/kdcbeehimalgmeoeajnflggejlemclnn.svg)](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn)
[![GitHub Pages](https://img.shields.io/badge/website-polly--for--chrome-blue)](https://vivswan.github.io/polly-for-chrome/)
[![GitHub](https://img.shields.io/github/license/vivswan/polly-for-chrome)](LICENSE)

A premium Chrome extension that transforms any text on the web into high-quality, natural-sounding speech using Amazon
Polly's advanced AI voices. Support for 40+ languages and hundreds of professional voices.

🌐 **[Visit Website](https://vivswan.github.io/polly-for-chrome/)** | 🛒
*[Chrome Web Store](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn)*

## ✨ Key Features

* **🎵 40+ Languages & Hundreds of Voices** - Choose from Standard, Neural, Generative, and Long-form voice engines
* **⚡ Multiple Speed Options** - Context menu with 1x, 1.5x, and 2x playback speeds
* **🛡️ Smart Text Processing** - Automatically sanitizes HTML content using sanitize-html library
* **⌨️ Keyboard Shortcuts** - Quick access with Ctrl+Shift+S (read aloud) and Ctrl+Shift+E (download)
* **💾 Audio Downloads** - Save as high-quality MP3 files for offline use
* **🔧 SSML Support** - Advanced markup for precise speech control
* **🔒 Secure & Private** - Your AWS credentials stay local and private

## 🚀 Quick Start

1. **Install Extension**: Add
   from [Chrome Web Store](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn)
2. **Setup AWS**: Create AWS account and configure Polly
   access ([detailed guide](https://vivswan.github.io/polly-for-chrome/#install))
3. **Start Converting**: Highlight any text, right-click, and choose your preferred speed

## 💰 Pricing

- **Extension**: Completely FREE
- **AWS Free Tier**: 5 million characters per month for 12 months
- **Standard voices**: $4 per million characters
- **Neural voices**: $16 per million characters
- **Generative voices**: $30 per million characters

[View detailed pricing →](https://aws.amazon.com/polly/pricing/)

## 🔧 AWS Setup

### Quick Setup

1. Create an AWS account at [aws.amazon.com](https://aws.amazon.com)
2. Go to IAM service and create a new user
3. Attach the `AmazonPollyReadOnlyAccess` policy
4. Generate access keys for the user
5. Enter credentials in the extension settings

For detailed setup instructions with screenshots, visit our [help guide](https://vivswan.github.io/polly-for-chrome/).

## 🛠️ Development

### Extension Development

```bash
npm install
npm run build
```

Load the unpacked extension from the `dist` folder.

### Website Development

```bash
npm install
npm run build
```

Website files are generated in the `public` folder.

### Available Scripts

- `npm run build` - Build Chrome extension and website
- `npm run dev` - Development mode with file watching
- `npm run lint` - Run ESLint
- `npm run typecheck` - Run TypeScript type checking

## 📁 Project Structure

```
├── src/
│   ├── components/          # React components
│   ├── helpers/            # Utility functions
│   ├── assets/             # Images, CSS, HTML files
│   │   └── images/
│   │       └── screenshots/ # Website screenshots
│   ├── index.tsx           # Website homepage
│   ├── popup.tsx           # Extension popup
│   ├── help.tsx            # Help page
│   └── changelog.tsx       # Changelog page
├── dist/                   # Built extension files
├── scripts/                # Build scripts
└── .github/workflows/      # GitHub Actions
```

## 🌐 Website

The project includes a marketing website built with React and Tailwind CSS:

- **URL**: [https://vivswan.github.io/polly-for-chrome/](https://vivswan.github.io/polly-for-chrome/)
- **Auto-deployed** via GitHub Actions on every push to main
- **Build command**: `npm run build`

## 🤝 Contributing

Contributions are welcome! Please feel free to submit a Pull Request. For major changes, please open an issue first to
discuss what you would like to change.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📄 License

This project is based on [Wavenet for Chrome](https://github.com/pgmichael/wavenet-for-chrome) and licensed under
the [MIT License](LICENSE).

## 🔗 Links

- **Website**: [https://vivswan.github.io/polly-for-chrome/](https://vivswan.github.io/polly-for-chrome/)
- **Chrome Web Store**: [Install Extension](https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn)
- **Issues**: [Report Bugs](https://github.com/vivswan/polly-for-chrome/issues)
- **AWS Polly Docs**: [Documentation](https://docs.aws.amazon.com/polly/)

---

⭐ **Star this repository if you find it helpful!**
