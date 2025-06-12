import React from 'react'
import { createRoot } from 'react-dom/client'

function Changelog() {
  return (
    <div className="flex justify-center bg-neutral-50 bg-opacity-30">
      <div className="flex flex-col items-center justify-center w-full max-w-4xl p-8">
        <div className="flex flex-col justify-center gap-6 pt-8">
          <div className="flex justify-center">
            <div className="flex items-center text-center">
              <img
                src="assets/images/icon_1000.png"
                className="mr-4 pt-0.5"
                style={{ width: '64px' }}
              />
              <div>
                <div className="text-4xl font-bold text-neutral-800">
                  Polly for Chrome
                </div>
                <div
                  className="text-2xl font-bold text-neutral-500"
                  style={{ marginTop: '-5px' }}
                >
                  Changelog
                </div>
              </div>
            </div>
          </div>
        </div>

        <div className="w-full max-w-4xl p-6 space-y-8">

          {/* Latest Version */}
          <Version
            version="1.0.3"
            type="patch"
            title="🌐 Website & Chrome Web Store Preparation"
            changes={[]}
          />

          {/* Previous Version */}
          <Version
            version="1.0.2"
            type="minor"
            title="🚀 Enhanced Speed Controls & Text Safety"
            changes={[
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
            ]}
          />

          {/* Previous Version */}
          <Version
            version="1.0.1"
            type="patch"
            title="🔧 Bug Fixes & Optimizations"
            changes={[]}
          />

          {/* Core Features */}
          <Version
            version="1.0.0"
            type="major"
            title="🎉 Initial Release"
            changes={[
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
            ]}
          />


        </div>
      </div>
    </div>
  )
}

// Helper Components
interface Change {
  type: 'feature' | 'improvement' | 'fix' | 'security' | 'breaking'
  title: string
  description: string
  details?: string[]
}

interface VersionProps {
  version: string
  type: 'major' | 'minor' | 'patch'
  title: string
  changes: Change[]
}

function Version({ version, type, title, changes }: VersionProps) {
  const getTypeColor = (type: string) => {
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

  return (
    <div className="bg-white rounded-lg shadow-sm border p-6">
      <div className="flex items-center gap-3 mb-4">
        <span className={`px-3 py-1 rounded-full text-white text-sm font-bold ${getTypeColor(type)}`}>
          v{version}
        </span>
      </div>

      <h2 className="text-2xl font-bold text-gray-800 mb-4">{title}</h2>

      <div className="space-y-4">
        {changes.map((change, index) => (
          <ChangeItem key={index} change={change} />
        ))}
      </div>
    </div>
  )
}

function ChangeItem({ change }: { change: Change }) {
  const getChangeIcon = (type: string) => {
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

  const getChangeColor = (type: string) => {
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

  return (
    <div className={`border-l-4 p-4 ${getChangeColor(change.type)}`}>
      <h4 className="font-semibold text-gray-800 mb-2">
        {getChangeIcon(change.type)} {change.title}
      </h4>
      <p className="text-gray-700 mb-2">{change.description}</p>
      {change.details && (
        <ul className="list-disc list-inside text-gray-600 space-y-1 text-sm">
          {change.details.map((detail, index) => (
            <li key={index}>{detail}</li>
          ))}
        </ul>
      )}
    </div>
  )
}


const root = document.createElement('div')
root.id = 'changelog-root'

document.body.appendChild(root)

createRoot(root).render(<Changelog />)