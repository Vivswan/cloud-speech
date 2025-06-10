import React from 'react'
import { useSession } from '../../hooks/useSession'
import { useSync } from '../../hooks/useSync'
import { Dropdown } from '../inputs/Dropdown'
import { Range } from '../inputs/Range'
import { EngineOption, LanguageOption, SessionStorage, VoiceOption } from '../../types'

const downloadAudioFormats = [
  { value: 'MP3_64_KBPS', title: 'MP3 (64kbps)', description: 'Recommended' },
  { value: 'MP3', title: 'MP3 (32kbps)' }
]

const readingAudioFormats = [
  { value: 'OGG_OPUS', title: 'OGG', description: 'Recommended' },
  { value: 'LINEAR16', title: 'WAV' },
  { value: 'MP3_64_KBPS', title: 'MP3 (64kbps)' },
  { value: 'MP3', title: 'MP3 (32kbps)' }
]


export function Preferences() {
  const { ready: sessionReady, session } = useSession()
  const { ready: syncReady, sync, setSync } = useSync()

  if (!sessionReady || !syncReady) return null
  const languageOptions = getLanguageOptions(session)
  const engineOptions = getEngineOptions(session, sync.language)
  const voiceOptions = getVoiceOptions(session, sync.language, sync.engine)
  const voice = sync.voices[sync.language] || voiceOptions[0]?.value


  return (
    <div className="flex flex-col gap-5">
      <div className={!sync.credentialsValid ? 'opacity-50 pointer-events-none' : ''}>
        <div className="font-semibold text-neutral-700 mb-1.5 ml-1 flex items-center">
          Audio playback
        </div>
        <div className="grid gap-4 grid-cols-1 bg-white p-3 rounded shadow-sm border">
          <div className="grid grid-cols-2 gap-4">
            <Dropdown
              label="Language"
              value={sync.language}
              onChange={(language) => {
                if (languageOptions.find((l: LanguageOption) => l.value === language)) {
                  const newEngineOptions = getEngineOptions(session, language)
                  const isCurrentEngineValid = newEngineOptions.find((e: EngineOption) => e.value === sync.engine)
                  const newEngine = isCurrentEngineValid ? sync.engine : newEngineOptions[0]?.value

                  const newVoiceOptions = getVoiceOptions(session, language, newEngine)
                  const currentVoice = sync.voices[language]
                  const isCurrentVoiceValid = currentVoice && newVoiceOptions.find((v: VoiceOption) => v.value === currentVoice)
                  const newVoice = isCurrentVoiceValid ? currentVoice : newVoiceOptions[0]?.value

                  setSync({
                    ...sync,
                    language,
                    engine: newEngine,
                    voices: { ...sync.voices, [language]: newVoice }
                  })
                }
              }}
              placeholder="Select language"
              options={languageOptions}
            />
            <Dropdown
              label="Engine"
              value={sync.engine}
              onChange={(engine) => {
                if (engineOptions.find((e: EngineOption) => e.value === engine)) {
                  const newVoiceOptions = getVoiceOptions(session, sync.language, engine)
                  const currentVoice = sync.voices[sync.language]
                  const isCurrentVoiceValid = currentVoice && newVoiceOptions.find((v: VoiceOption) => v.value === currentVoice)
                  const newVoice = isCurrentVoiceValid ? currentVoice : newVoiceOptions[0]?.value

                  setSync({
                    ...sync,
                    engine,
                    voices: { ...sync.voices, [sync.language]: newVoice }
                  })
                }
              }}
              placeholder="Select engine"
              options={engineOptions}
            />
          </div>
          <div className="grid grid-cols-1 gap-4">
            <Dropdown
              label="Voice"
              value={voice}
              onChange={(voice) => {
                if (voiceOptions.find((v: VoiceOption) => v.value === voice)) {
                  setSync({
                    ...sync,
                    voices: { ...sync.voices, [sync.language]: voice }
                  })
                }
              }}
              placeholder="Select voice"
              options={voiceOptions}
            />
          </div>
          <div className="grid gap-4">
            <Range
              label="Speed"
              min={0.5}
              max={3}
              step={0.05}
              value={sync.speed}
              unit="×"
              onChange={(speed) => setSync({ ...sync, speed })}
              ticks={[0.5, 1, 1.5, 2, 2.5, 3]}
            />
            <Range
              label="Pitch"
              min={-10}
              max={10}
              step={0.1}
              value={sync.pitch}
              onChange={(pitch) => setSync({ ...sync, pitch })}
              ticks={[-10, -5, 0, 5, 10]}
            />
            <Range
              label="Volume Gain"
              min={-16}
              max={16}
              step={1}
              value={sync.volumeGainDb}
              unit="dB"
              onChange={(volumeGainDb) => setSync({ ...sync, volumeGainDb })}
              ticks={[-16, -8, 0, 8, 16]}
            />
          </div>
        </div>
      </div>
      <div className={!sync.credentialsValid ? 'opacity-50 pointer-events-none' : ''}>
        <div className="font-semibold text-neutral-700 mb-1.5 ml-1 flex items-center">
          Audio format
        </div>
        <div className="grid gap-4 grid-cols-2 bg-white p-3 rounded shadow-sm border">
          <Dropdown
            label="When downloading"
            value={sync.downloadEncoding}
            options={downloadAudioFormats}
            onChange={(downloadEncoding) => {
              if (
                downloadAudioFormats.find((f: any) => f.value === downloadEncoding)
              ) {
                setSync({ ...sync, downloadEncoding })
              }
            }}
          />
          <Dropdown
            label="When reading aloud"
            value={sync.readAloudEncoding}
            options={readingAudioFormats}
            onChange={(readAloudEncoding) => {
              if (
                readingAudioFormats.find((f: any) => f.value === readAloudEncoding)
              ) {
                setSync({ ...sync, readAloudEncoding })
              }
            }}
          />
        </div>
      </div>
    </div>
  )
}

function getVoiceOptions(session: SessionStorage, language: string, engine: string): VoiceOption[] {
  if (!session?.voices) return []
  const voicesInLanguage = session.voices?.filter((voice) =>
    voice.languageCodes.includes(language) && voice.supportedEngines.includes(engine)
  ) || []

  const voiceNames = voicesInLanguage.map(({ name: value, ssmlGender }) => {
    // AWS Polly voice names are already human-readable (e.g., "Joanna", "Matthew")
    const title = value
    const description =
      ssmlGender.toLowerCase().charAt(0).toUpperCase() +
      ssmlGender.toLowerCase().slice(1)

    return { value, title, description }
  })

  const sortedVoices = voiceNames.sort((a, b) => {
    if (a.title < b.title) return -1
    if (a.title > b.title) return 1
    return 0
  })

  return sortedVoices
}

function getLanguageOptions(session: SessionStorage): LanguageOption[] {
  if (!session?.languages) return []
  const displayNames = new Intl.DisplayNames(['en-US'], {
    type: 'language',
    languageDisplay: 'standard'
  })

  const languageNames = session.languages?.map((value) => {
    try {
      // AWS Polly uses extended language codes like 'en-GB-WLS' that aren't valid BCP 47
      // Normalize to standard BCP 47 format for DisplayNames
      let normalizedCode = value
      const parts = value.split('-')

      // Handle AWS Polly's three-part codes (e.g., en-GB-WLS -> en-GB)
      if (parts.length > 2) {
        normalizedCode = `${parts[0]}-${parts[1]}`
      }

      // Try to get display name with normalized code first
      let displayName
      try {
        displayName = displayNames.of(normalizedCode)
      } catch (e) {
        // If normalized code fails, try just the language part
        displayName = displayNames.of(parts[0])
      }

      if (!displayName) {
        // Create a readable fallback from the original code
        const language = parts[0].toUpperCase()
        const region = parts[1] ? parts[1].toUpperCase() : ''
        const variant = parts[2] ? parts[2] : ''
        const title = variant ? `${language} (${region}-${variant})` : region ? `${language} (${region})` : language
        return { value, title, description: 'Custom language variant' }
      }

      let [title, ...tail] = displayName.split(' ')

      // Add region/variant info from original AWS code
      if (parts.length > 1) {
        if (parts.length > 2) {
          // Three parts: language-region-variant (e.g., en-GB-WLS)
          title += ` (${parts[1]}-${parts[2]})`
        } else {
          // Two parts: language-region (e.g., en-GB)
          title += ` (${parts[1]})`
        }
      }

      let description = tail.join(' ')
      if (description.startsWith('(')) description = description.slice(1, -1)
      if (description.endsWith(')')) description = description.slice(0, -1)

      return { value, title, description }
    } catch (error) {
      console.warn(`Error processing language code ${value}:`, error)
      // Enhanced fallback with better formatting
      const parts = value.split('-')
      const language = parts[0] ? parts[0].toUpperCase() : 'Unknown'
      const region = parts[1] ? parts[1].toUpperCase() : ''
      const variant = parts[2] ? parts[2] : ''

      let title = language
      if (region && variant) {
        title += ` (${region}-${variant})`
      } else if (region) {
        title += ` (${region})`
      }

      return { value, title, description: 'Language variant' }
    }
  }).filter(Boolean)

  const sortedLanguages = Array.from(languageNames).sort((a: any, b: any) => {
    if (a.title < b.title) return -1
    if (a.title > b.title) return 1
    return 0
  })

  return sortedLanguages as LanguageOption[]
}

function getEngineOptions(session: SessionStorage, language: string): EngineOption[] {
  if (!session?.voices) return []

  const voicesInLanguage = session.voices?.filter((voice) =>
    voice.languageCodes.includes(language)
  ) || []

  const engines = new Set(
    voicesInLanguage.map((voice) => voice.supportedEngines).flat()
  )

  const engineOptions = Array.from(engines).map((engine) => {
    const engineNames = {
      'standard': { title: 'Standard', description: 'Basic quality, cost-effective' },
      'neural': { title: 'Neural', description: 'High quality, natural sounding' },
      'generative': { title: 'Generative', description: 'Most natural, latest technology' },
      'long-form': { title: 'Long-form', description: 'Optimized for long content' }
    }

    const engineInfo = engineNames[engine.toLowerCase()] || {
      title: engine.charAt(0).toUpperCase() + engine.slice(1).toLowerCase(),
      description: 'Voice engine'
    }

    return {
      value: engine,
      title: engineInfo.title,
      description: engineInfo.description
    }
  })

  const sortedEngines = engineOptions.sort((a, b) => {
    const order = ['standard', 'neural', 'generative', 'long-form']
    const aIndex = order.indexOf(a.value.toLowerCase())
    const bIndex = order.indexOf(b.value.toLowerCase())

    if (aIndex !== -1 && bIndex !== -1) {
      return aIndex - bIndex
    }

    if (a.title < b.title) return -1
    if (a.title > b.title) return 1
    return 0
  })

  return sortedEngines
}
