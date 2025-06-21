// Changelog functionality
console.log('Polly for Chrome changelog loaded')

// Types
interface Change {
  type: 'feature' | 'improvement' | 'fix' | 'security' | 'breaking'
  title: string
  description: string
  details?: string[]
}

interface Version {
  version: string
  type: 'major' | 'minor' | 'patch'
  title: string
  changes: Change[]
}

// Changelog data
const versions: Version[] = [
  {
    version: '1.0.3',
    type: 'patch',
    title: '🌐 Website & Chrome Web Store Preparation',
    changes: []
  },
  {
    version: '1.0.2',
    type: 'minor',
    title: '🚀 Enhanced Speed Controls & Text Safety',
    changes: [
      {
        type: 'feature',
        title: 'Multiple Speed Context Menu Options',
        description: 'Added dedicated context menu options for different playback speeds',
        details: [
          'Read Aloud (1x) - Normal speed playback',
          'Read Aloud (1.5x) - 1.5x speed playback',
          'Read Aloud (2x) - 2x speed playback',
          'Speed options temporarily override global settings',
          'Original \'Read Aloud\' option uses preferred speed setting'
        ]
      },
      {
        type: 'security',
        title: 'Smart Text Sanitization',
        description: 'Comprehensive text processing for safe speech synthesis',
        details: [
          'Using sanitize-html library for improved HTML processing',
          'Automatically removes HTML tags while preserving content',
          'Safely escapes XML special characters (<, >, &, ", \')',
          'Completely removes dangerous content (script, style tags)',
          'Properly handles HTML entities (decodes then re-encodes)',
          'Preserves valid SSML markup for advanced users',
          'Protects against malformed or malicious content'
        ]
      },
      {
        type: 'improvement',
        title: 'Refactored Speech Synthesis',
        description: 'Improved code architecture for better maintainability',
        details: [
          'Synthesize function now accepts structured parameters',
          'Better separation of concerns between functions',
          'More consistent parameter handling throughout codebase',
          'Enhanced type safety with TypeScript interfaces'
        ]
      },
      {
        type: 'improvement',
        title: 'Enhanced Help Documentation',
        description: 'Updated help guide with new features and examples',
        details: [
          'Added documentation for speed control options',
          'Included text sanitization examples and explanations',
          'Expanded troubleshooting guides',
          'Better organization of feature descriptions'
        ]
      }
    ]
  },
  {
    version: '1.0.1',
    type: 'patch',
    title: '🔧 Bug Fixes & Optimizations',
    changes: []
  },
  {
    version: '1.0.0',
    type: 'major',
    title: '🎉 Initial Release',
    changes: [
      {
        type: 'feature',
        title: 'Amazon Polly Integration',
        description: 'High-quality text-to-speech using Amazon Web Services',
        details: [
          'Support for 40+ languages and hundreds of voices',
          'Multiple voice engines: Standard, Neural, Generative, Long-form',
          'Customizable speed, pitch, and volume controls',
          'SSML markup support for advanced speech control'
        ]
      },
      {
        type: 'feature',
        title: 'Context Menu Integration',
        description: 'Easy text-to-speech from any webpage',
        details: [
          'Right-click selected text to read aloud',
          'Download audio as MP3 files',
          'Works with any text content on the web'
        ]
      },
      {
        type: 'feature',
        title: 'Keyboard Shortcuts',
        description: 'Quick access via customizable hotkeys',
        details: [
          'Ctrl+Shift+S (Cmd+Shift+S on Mac) for read aloud',
          'Ctrl+Shift+E (Cmd+Shift+E on Mac) for download',
          'Configurable shortcuts in extension settings'
        ]
      },
      {
        type: 'feature',
        title: 'Audio Format Options',
        description: 'Multiple audio formats for different needs',
        details: [
          'OGG Opus for efficient streaming playback',
          'MP3 for downloads and compatibility',
          'Configurable quality settings'
        ]
      },
      {
        type: 'feature',
        title: 'Secure Credential Management',
        description: 'Safe storage of AWS credentials',
        details: [
          'Local storage of AWS access keys',
          'Credential validation with helpful error messages',
          'Support for all AWS regions'
        ]
      }
    ]
  }
]

// Helper functions
function getTypeColor(type: string): string {
  switch (type) {
    case 'major':
      return 'bg-green-500'
    case 'minor':
      return 'bg-blue-500'
    case 'patch':
      return 'bg-yellow-500'
    default:
      return 'bg-gray-500'
  }
}

function getChangeIcon(type: string): string {
  switch (type) {
    case 'feature':
      return '✨'
    case 'improvement':
      return '🔧'
    case 'fix':
      return '🐛'
    case 'security':
      return '🛡️'
    case 'breaking':
      return '⚠️'
    default:
      return '📝'
  }
}

function getChangeColor(type: string): string {
  switch (type) {
    case 'feature':
      return 'border-green-400 bg-green-50'
    case 'improvement':
      return 'border-blue-400 bg-blue-50'
    case 'fix':
      return 'border-red-400 bg-red-50'
    case 'security':
      return 'border-purple-400 bg-purple-50'
    case 'breaking':
      return 'border-orange-400 bg-orange-50'
    default:
      return 'border-gray-400 bg-gray-50'
  }
}

// DOM manipulation functions
function createChangeItem(change: Change): HTMLElement {
  const changeDiv = document.createElement('div')
  changeDiv.className = `border-l-4 p-4 ${getChangeColor(change.type)}`

  const title = document.createElement('h4')
  title.className = 'font-semibold text-gray-800 mb-2'
  title.textContent = `${getChangeIcon(change.type)} ${change.title}`

  const description = document.createElement('p')
  description.className = 'text-gray-700 mb-2'
  description.textContent = change.description

  changeDiv.appendChild(title)
  changeDiv.appendChild(description)

  if (change.details && change.details.length > 0) {
    const detailsList = document.createElement('ul')
    detailsList.className = 'list-disc list-inside text-gray-600 space-y-1 text-sm'

    change.details.forEach(detail => {
      const listItem = document.createElement('li')
      listItem.textContent = detail
      detailsList.appendChild(listItem)
    })

    changeDiv.appendChild(detailsList)
  }

  return changeDiv
}

function createVersionElement(version: Version): HTMLElement {
  const versionDiv = document.createElement('div')
  versionDiv.className = 'bg-white rounded-lg shadow-sm border p-6'

  // Version header
  const header = document.createElement('div')
  header.className = 'flex items-center gap-3 mb-4'

  const versionBadge = document.createElement('span')
  versionBadge.className = `px-3 py-1 rounded-full text-white text-sm font-bold ${getTypeColor(version.type)}`
  versionBadge.textContent = `v${version.version}`

  header.appendChild(versionBadge)

  // Version title
  const title = document.createElement('h2')
  title.className = 'text-2xl font-bold text-gray-800 mb-4'
  title.textContent = version.title

  // Changes container
  const changesContainer = document.createElement('div')
  changesContainer.className = 'space-y-4'

  version.changes.forEach(change => {
    const changeElement = createChangeItem(change)
    changesContainer.appendChild(changeElement)
  })

  versionDiv.appendChild(header)
  versionDiv.appendChild(title)
  versionDiv.appendChild(changesContainer)

  return versionDiv
}

// Initialize changelog
function initializeChangelog(): void {
  console.log('Initializing changelog...')

  const container = document.getElementById('changelog-container')
  if (!container) {
    console.error('Changelog container not found')
    return
  }

  // Clear existing content
  container.innerHTML = ''

  // Add all versions
  versions.forEach(version => {
    const versionElement = createVersionElement(version)
    container.appendChild(versionElement)
  })

  console.log(`Changelog initialized with ${versions.length} versions`)
}

// Initialize when DOM is ready
document.addEventListener('DOMContentLoaded', initializeChangelog)