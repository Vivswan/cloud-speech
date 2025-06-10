# Polly For Chrome

A Chrome extension that allows you to convert text to speech using Amazon Polly. It supports all Amazon Polly voices and
languages, including Standard, Neural, Generative, and Long-form voices.

## Features

* Support for all Amazon Polly voices and languages (Standard, Neural, Generative, and Long-form).
* Adjustable speed and pitch.
* Download selected text to an MP3 file.
* [SSML support](https://docs.aws.amazon.com/polly/latest/dg/ssml.html)
* Shortcut to read aloud (`Cmd+Shift+S` on macOS and `Ctrl+Shift+S` on windows)
* Shortcut to download selected text (`Cmd+Shift+E` on macOS and `Ctrl+Shift+E` on windows)
* Chunk selected text into sentences to bypass character limits and optimize performance.
* Use your own AWS credentials for Polly access.

### Using your own AWS credentials

* Create an AWS account and set up an IAM user with Polly permissions.
* Generate Access Key ID and Secret Access Key for the IAM user.
* Enter your AWS credentials in the extension's popup menu (under Settings > AWS Credentials).

Usage will be charged through your AWS account as per Amazon
Polly's [pricing policy](https://aws.amazon.com/polly/pricing/).

## Development
If you're interested in contributing, you can easily get started by running the following commands and loading the unpacked extension from the `dist` folder.

```
npm install

npm run build
```


## License
[MIT](/LICENSE)
