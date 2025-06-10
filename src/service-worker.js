import './helpers/text-helpers.js'
import { fileExtMap } from './helpers/file-helpers.js'

// Local state -----------------------------------------------------------------
let queue = []
let playing = false
let cancellationToken = false
let bootstrappedResolver = null

const bootstrapped = new Promise((resolve) => (bootstrappedResolver = resolve))

// Bootstrap -------------------------------------------------------------------
;(async function Bootstrap() {
  await migrateSyncStorage()
  await handlers.fetchVoices()
  await setDefaultSettings()
  await createContextMenus()
  bootstrappedResolver()
})()

// Event listeners -------------------------------------------------------------
chrome.commands.onCommand.addListener(function (command) {
  console.log('Handling command...', ...arguments)

  if (!handlers[command]) throw new Error(`No handler found for ${command}`)

  handlers[command]()
})

chrome.runtime.onMessage.addListener(function (request, sender, sendResponse) {
  console.log('Handling message...', ...arguments)

  const { id, payload } = request

  if (!handlers[id]) throw new Error(`No handler found for ${id}`)
  handlers[id](payload).then(sendResponse)

  return true
})

chrome.storage.onChanged.addListener(function (changes) {
  console.log('Handling storage change...', ...arguments)

  if (!changes.downloadEncoding) return

  updateContextMenus()
})

chrome.contextMenus.onClicked.addListener(function (info, tab) {
  console.log('Handling context menu click...', ...arguments)

  const id = info.menuItemId
  const payload = { text: info.selectionText }

  if (!handlers[id]) throw new Error(`No handler found for ${id}`)

  handlers[id](payload)
})

chrome.runtime.onInstalled.addListener(async function (details) {
  console.log('Handling runtime install...', ...arguments)

  const self = await chrome.management.getSelf()
  if (details.reason === 'install' && self.installType !== 'development') {
    const helpUrl = chrome.runtime.getURL('public/help.html')

    chrome.tabs.create({ url: helpUrl })
  }
})

// Handlers --------------------------------------------------------------------
export const handlers = {
  readAloud: async function ({ text }) {
    console.log('Reading aloud...', ...arguments)

    if (playing) await this.stopReading()

    const chunks = text.chunk()
    console.log('Chunked text into', chunks.length, 'chunks', chunks)

    queue.push(...chunks)
    playing = true
    updateContextMenus()

    let count = 0
    const sync = await chrome.storage.sync.get()
    const encoding = sync.readAloudEncoding
    const prefetchQueue = []
    cancellationToken = false
    while (queue.length) {
      if (cancellationToken) {
        cancellationToken = false
        playing = false
        updateContextMenus()
        return
      }

      const text = queue.shift()
      const nextText = queue[0]

      if (nextText) {
        prefetchQueue.push(this.getAudioUri({ text: nextText, encoding }))
      }

      const audioUri =
        count === 0
          ? await this.getAudioUri({ text, encoding })
          : await prefetchQueue.shift()

      try {
        await createOffscreenDocument()
        await chrome.runtime.sendMessage({
          id: 'play',
          payload: { audioUri },
          offscreen: true,
        })
      } catch (e) {
        console.warn('Failed to play audio', e)

        // Audio playback may have failed because the user stopped playback, or
        // called the readAloud function again. We need to return early to avoid
        // playing the next chunk.
        return
      }

      console.log('Play through of audio complete. Enqueuing next chunk.')
      count++
    }

    playing = false
    updateContextMenus()
    return Promise.resolve(true)
  },
  readAloudShortcut: async function () {
    console.log('Handling read aloud shortcut...', ...arguments)

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: retrieveSelection,
    })
    const text = result[0].result

    if (playing) {
      await this.stopReading()

      if (!text) return
    }

    this.readAloud({ text })
  },
  stopReading: async function () {
    console.log('Stopping reading...', ...arguments)

    cancellationToken = true
    queue = []
    playing = false
    updateContextMenus()

    try {
      await createOffscreenDocument()
      await chrome.runtime.sendMessage({
        id: 'stop',
        offscreen: true,
      })
    } catch (e) {
      console.warn('Failed to stop audio', e)
    }

    return Promise.resolve(true)
  },
  download: async function ({ text }) {
    console.log('Downloading audio...', ...arguments)

    const { downloadEncoding: encoding } = await chrome.storage.sync.get()
    const url = await this.getAudioUri({ text, encoding })

    console.log('Downloading audio from', url)
    chrome.downloads.download({
      url,
      filename: `tts-download.${fileExtMap[encoding]}`,
    })

    return Promise.resolve(true)
  },
  downloadShortcut: async function () {
    console.log('Handling download shortcut...', ...arguments)

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const result = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: retrieveSelection,
    })
    const text = result[0].result

    this.download({ text })
  },
  synthesize: async function ({ text, encoding }) {
    console.log('Synthesizing text...', ...arguments)

    const sync = await chrome.storage.sync.get()
    const voice = sync.voices[sync.language]
    const count = text.length

    if (!sync.accessKeyId || !sync.secretAccessKey || !sync.region) {
      sendMessageToCurrentTab({
        id: 'setError',
        payload: {
          icon: 'error',
          title: 'AWS credentials are missing',
          message: 'Please enter valid AWS Access Key ID, Secret Access Key, and Region in the extension popup. Instructions: https://docs.aws.amazon.com/polly/latest/dg/setting-up.html'
        },
      })

      throw new Error('AWS credentials are missing')
    }

    let ssml
    if (text.isSSML()) {
      ssml = text
      text = undefined
    }

    // Map audio formats to Polly supported formats
    const formatMap = {
      'MP3': 'mp3',
      'MP3_64_KBPS': 'mp3',
      'OGG_OPUS': 'ogg_vorbis',
      'LINEAR16': 'pcm'
    }

    const pollyParams = {
      OutputFormat: formatMap[encoding] || 'mp3',
      Text: ssml || text,
      TextType: ssml ? 'ssml' : 'text',
      VoiceId: voice,
      Engine: voice.includes('Neural') ? 'neural' : 'standard'
    }

    const response = await this.callPollyAPI('SynthesizeSpeech', pollyParams, sync)

    if (!response.ok) {
      const errorText = await response.text()
      console.error('Polly API error:', errorText)

      sendMessageToCurrentTab({
        id: 'setError',
        payload: { title: 'Failed to synthesize text', message: errorText }
      })

      await this.stopReading()

      throw new Error(errorText)
    }

    const audioBuffer = await response.arrayBuffer()
    const audioContent = btoa(String.fromCharCode(...new Uint8Array(audioBuffer)))


    return audioContent
  },
  getAudioUri: async function ({ text, encoding }) {
    console.log('Getting audio URI...', ...arguments)

    const chunks = text.chunk()
    console.log('Chunked text into', chunks.length, 'chunks', chunks)

    const promises = chunks.map((text) => this.synthesize({ text, encoding }))
    const audioContents = await Promise.all(promises)

    return (
      `data:audio/${fileExtMap[encoding]};base64,` +
      btoa(audioContents.map(atob).join(''))
    )
  },
  fetchVoices: async function () {
    console.log('Fetching voices...', ...arguments)

    try {
      const sync = await chrome.storage.sync.get()

      if (!sync.accessKeyId || !sync.secretAccessKey || !sync.region) {
        console.warn('AWS credentials not configured')
        return false
      }

      const response = await this.callPollyAPI('DescribeVoices', {}, sync)

      if (!response.ok) {
        const errorText = await response.text()
        console.error('Polly DescribeVoices error:', response.status, errorText)
        throw new Error(`Failed to fetch voices: ${response.status} - ${errorText}`)
      }

      const data = await response.json()
      const voices = data.Voices || []
      if (!voices.length) throw new Error('No voices found')

      // Transform Polly voice format to match the expected structure
      const transformedVoices = voices.map(voice => ({
        name: voice.Id,
        ssmlGender: voice.Gender || 'NEUTRAL',
        languageCodes: [voice.LanguageCode],
        naturalSampleRateHertz: voice.SampleRate || 22050
      }))

      await chrome.storage.session.set({ voices: transformedVoices })
      await setLanguages()

      return transformedVoices
    } catch (e) {
      console.warn('Failed to fetch voices', e)

      return false
    }
  },
}

// Helpers ---------------------------------------------------------------------
async function updateContextMenus() {
  console.log('Updating context menus...', { playing })

  // Prevents context menus from being updated before they are created,
  // which causes an unnecessary error in the console.
  await bootstrapped

  const commands = await chrome.commands.getAll()
  const encoding = (await chrome.storage.sync.get()).downloadEncoding
  const fileExt = fileExtMap[encoding]
  const downloadShortcut = commands.find((c) => c.name === 'downloadShortcut')?.shortcut

  chrome.contextMenus.update('readAloud', {
    enabled: true
  })

  chrome.contextMenus.update('stopReading', {
    enabled: playing
  })

  chrome.contextMenus.update('download', {
    title: `Download ${fileExt?.toUpperCase()}${downloadShortcut && ` (${downloadShortcut})`}`,
  })
}

async function createContextMenus() {
  console.log('Creating context menus...', ...arguments)
  chrome.contextMenus.removeAll()


  const commands = await chrome.commands.getAll()
  const readAloudShortcut = commands.find((c) => c.name === 'readAloudShortcut')?.shortcut
  const downloadShortcut = commands.find((c) => c.name === 'downloadShortcut')?.shortcut
  const downloadEncoding = (await chrome.storage.sync.get()).downloadEncoding
  const fileExt = fileExtMap[downloadEncoding]

  chrome.contextMenus.create({
    id: 'readAloud',
    title: `Read aloud${readAloudShortcut && ` (${readAloudShortcut})`}`,
    contexts: ['selection'],
    enabled: !playing,
  })

  chrome.contextMenus.create({
    id: 'stopReading',
    title: `Stop reading${readAloudShortcut && ` (${readAloudShortcut})`}`,
    contexts: ['all'],
    enabled: playing,
  })

  chrome.contextMenus.create({
    id: 'download',
    title: `Download ${fileExt?.toUpperCase()}${downloadShortcut && ` (${downloadShortcut})`}`,
    contexts: ['selection'],
  })
}

let creating
async function createOffscreenDocument() {
  const path = 'public/offscreen.html'

  if (await hasOffscreenDocument(path)) return

  if (creating) {
    await creating
  } else {
    creating = chrome.offscreen.createDocument({
      url: path,
      reasons: [chrome.offscreen.Reason.AUDIO_PLAYBACK],
      justification: 'Plays synthesized audio in the background',
    })
    await creating
    creating = null
  }
}

async function hasOffscreenDocument(path) {
  console.log('Checking if offscreen document exists...', ...arguments)

  const offscreenUrl = chrome.runtime.getURL(path)
  const matchedClients = await clients.matchAll()

  for (const client of matchedClients) {
    if (client.url === offscreenUrl) return true
  }

  return false
}

export async function setDefaultSettings() {
  console.log('Setting default settings...', ...arguments)

  await chrome.storage.session.setAccessLevel({
    accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS',
  })

  const sync = await chrome.storage.sync.get()
  await chrome.storage.sync.set({
    language: sync.language || 'en-US',
    speed: sync.speed || 1,
    pitch: sync.pitch || 0,
    voices: sync.voices || { 'en-US': 'Joanna' },
    readAloudEncoding: sync.readAloudEncoding || 'OGG_OPUS',
    downloadEncoding: sync.downloadEncoding || 'MP3_64_KBPS',
    accessKeyId: sync.accessKeyId || '',
    secretAccessKey: sync.secretAccessKey || '',
    region: sync.region || 'us-east-1',
    audioProfile: sync.audioProfile || 'default',
    volumeGainDb: sync.volumeGainDb || 0,
  })
}

async function migrateSyncStorage() {
  console.log('Migrating sync storage...', ...arguments)

  const sync = await chrome.storage.sync.get()

  // Extension with version 8 had WAV and OGG_OPUS as a download option, but
  // it was rolled back in version 9. Due to audio stiching issues.
  if (
    Number(chrome.runtime.getManifest().version) <= 9 &&
    (sync.downloadEncoding == 'OGG_OPUS' || sync.downloadEncoding == 'LINEAR16')
  ) {
    chrome.storage.sync.set({ downloadEncoding: 'MP3_64_KBPS' })
  }

  // Extensions with version < 8 had a different storage structure.
  // We need to migrate them to the new structure before we can use them.
  if (sync.voices || Number(chrome.runtime.getManifest().version) < 8) return

  await chrome.storage.sync.clear()

  const newSync = {}
  if (sync.locale) {
    const oldVoiceParts = sync.locale.split('-')
    newSync.language = [oldVoiceParts[0], oldVoiceParts[1]].join('-')
    newSync.voices = { [newSync.language]: sync.locale }
  }

  if (sync.speed) {
    newSync.speed = Number(sync.speed)
  }

  if (sync.pitch) {
    newSync.pitch = 0
  }

  // Migrate from Google Cloud API key to AWS credentials
  if (sync.apiKey) {
    // Clear old API key since we're now using AWS
    newSync.accessKeyId = ''
    newSync.secretAccessKey = ''
    newSync.region = 'us-east-1'
    newSync.credentialsValid = false
  }

  await chrome.storage.sync.set(newSync)
}

async function setLanguages() {
  console.log('Setting languages...', ...arguments)

  const session = await chrome.storage.session.get()

  if (!session.voices) {
    throw new Error('No voices found. Cannot set languages.')
  }

  const languages = new Set(
    session.voices.map((voice) => voice.languageCodes).flat()
  )

  await chrome.storage.session.set({ languages: Array.from(languages) })

  return languages
}

function retrieveSelection() {
  console.log('Retrieving selection...', ...arguments)

  const activeElement = document.activeElement
  if (activeElement?.tagName === 'INPUT' || activeElement?.tagName === 'TEXTAREA') {

    const start = activeElement.selectionStart
    const end = activeElement.selectionEnd

    return activeElement.value.slice(start, end)
  }

  return window.getSelection()?.toString()
}

// AWS Polly API helper function with corrected implementation
handlers.callPollyAPI = async function(action, params, credentials) {
  const { accessKeyId, secretAccessKey, region } = credentials
  const service = 'polly'
  const host = `${service}.${region}.amazonaws.com`
  const endpoint = `https://${host}`

  const payload = JSON.stringify(params)
  const now = new Date()
  const timestamp = now.toISOString().replace(/[:\-]|\.\d{3}/g, '')
  const date = timestamp.substr(0, 8)

  console.log('AWS API call details:', { action, region, host, payload })

  // HMAC function using crypto.subtle
  async function hmac(key, data) {
    const encoder = new TextEncoder()
    const keyBuffer = typeof key === 'string' ? encoder.encode(key) : key
    const dataBuffer = encoder.encode(data)

    const cryptoKey = await crypto.subtle.importKey(
      'raw', keyBuffer, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    )

    return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, dataBuffer))
  }

  // SHA256 hash function
  async function sha256(data) {
    const encoder = new TextEncoder()
    const dataBuffer = encoder.encode(data)
    const hashBuffer = await crypto.subtle.digest('SHA-256', dataBuffer)
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0')).join('')
  }

  // Calculate signature following AWS Signature Version 4 spec exactly
  const kDate = await hmac('AWS4' + secretAccessKey, date)
  const kRegion = await hmac(kDate, region)
  const kService = await hmac(kRegion, service)
  const kSigning = await hmac(kService, 'aws4_request')

  // Create canonical request (order matters!)
  const method = action === 'DescribeVoices' ? 'GET' : 'POST'
  const path = action === 'DescribeVoices' ? '/v1/voices' : '/v1/speech'
  const payloadHash = await sha256(payload)

  // Canonical headers must be in alphabetical order
  const canonicalHeaders = action === 'DescribeVoices'
    ? [
    `host:${host}`,
    `x-amz-date:${timestamp}`
  ].join('\n') + '\n'
    : [
    `content-type:application/json`,
    `host:${host}`,
    `x-amz-date:${timestamp}`
  ].join('\n') + '\n'

  const signedHeaders = action === 'DescribeVoices'
    ? 'host;x-amz-date'
    : 'content-type;host;x-amz-date'

  const canonicalRequest = [
    method,
    path,
    '', // No query string
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n')

  console.log('Canonical request:', canonicalRequest)

  // Create string to sign
  const algorithm = 'AWS4-HMAC-SHA256'
  const credentialScope = `${date}/${region}/${service}/aws4_request`
  const canonicalRequestHash = await sha256(canonicalRequest)

  const stringToSign = [
    algorithm,
    timestamp,
    credentialScope,
    canonicalRequestHash
  ].join('\n')

  console.log('String to sign:', stringToSign)

  // Calculate final signature
  const signature = Array.from(await hmac(kSigning, stringToSign))
    .map(b => b.toString(16).padStart(2, '0')).join('')

  // Create authorization header
  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  console.log('Authorization header:', authorization)

  const finalEndpoint = action === 'DescribeVoices' ? `${endpoint}/v1/voices` : `${endpoint}/v1/speech`

  return fetch(finalEndpoint, {
    method: action === 'DescribeVoices' ? 'GET' : 'POST',
    headers: {
      'Authorization': authorization,
      'X-Amz-Date': timestamp,
      ...(action !== 'DescribeVoices' && {
        'Content-Type': 'application/json'
      })
    },
    body: action === 'DescribeVoices' ? undefined : payload
  })
}

async function sendMessageToCurrentTab(event) {
  console.log('Sending message to current tab...', ...arguments)

  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const currentTab = tabs[0]

  if (!currentTab) {
    console.warn('No current tab found. Aborting message send.')
    return
  }

  chrome.tabs.sendMessage(currentTab.id, event)
}
