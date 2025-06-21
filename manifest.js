export default {
  name: 'Polly for Chrome',
  description: 'Transform any text on the web into high-quality, natural-sounding audio with Amazon Polly\'s advanced AI voices.',
  version: process.env.npm_package_version,
  manifest_version: 3,
  permissions: [
    'contextMenus',
    'downloads',
    'storage',
    'activeTab',
    'scripting',
    'offscreen'
  ],
  commands: {
    readAloudShortcut: {
      suggested_key: {
        default: 'Ctrl+Shift+S',
        mac: 'Command+Shift+S'
      },
      description: 'Read aloud'
    },
    downloadShortcut: {
      suggested_key: {
        default: 'Ctrl+Shift+E',
        mac: 'Command+Shift+E'
      },
      description: 'Download'
    }
  },
  background: {
    service_worker: 'service-worker.js',
    type: 'module'
  },
  host_permissions: [
    '<all_urls>'
  ],
  content_scripts: [
    {
      matches: ['<all_urls>'],
      js: ['content-script.js']
    }
  ],
  action: {
    default_title: 'Polly for Chrome',
    default_popup: 'popup.html',
    default_icon: 'images/icon_1000.png'
  },
  icons: {
    16: 'images/icon_16.png',
    19: 'images/icon_19.png',
    38: 'images/icon_38.png',
    48: 'images/icon_48.png',
    128: 'images/icon_128.png',
    1000: 'images/icon_1000.png'
  },
  web_accessible_resources: [
    {
      resources: ['css/styles.css'],
      matches: ['<all_urls>']
    }
  ],
  homepage_url: 'https://vivswan.github.io/polly-for-chrome/'
}