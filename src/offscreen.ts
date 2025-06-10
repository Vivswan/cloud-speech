// Local variables -------------------------------------------------------------
let audioElement = new Audio()
let shouldPlay = false

// Event listeners -------------------------------------------------------------
chrome.runtime.onMessage.addListener(function(request: any, sender: any, sendResponse: any) {
  if (!request) return

  const { id, payload, offscreen } = request
  if (!offscreen) return

  if (!(handlers as any)[id]) return
  (handlers as any)[id](payload).then(sendResponse)

  return true
})

// Handlers --------------------------------------------------------------------
const handlers = {
  play: function({ audioUri }: { audioUri: string }): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!audioUri) reject('No audioUri provided')

      shouldPlay = true

      audioElement.src = audioUri
      audioElement.onloadedmetadata = function() {
        if (!shouldPlay) {
          resolve('Playback was stopped before audio could start')
          return
        }

        audioElement
          .play()
          .catch((e) => reject('Error while trying to play audio: ' + e))
      }

      audioElement.onerror = function() {
        reject(`Error loading audio source: ${audioUri}`)
      }

      audioElement.onended = function() {
        resolve(`Finished playing`)
      }
    })
  },
  stop: function(): Promise<string> {
    return new Promise((resolve) => {
      shouldPlay = false

      if (!audioElement.paused) {
        audioElement.pause()
        audioElement.currentTime = 0

        resolve('Stopped audio')
        return
      }

      resolve('No audio is currently playing')
    })
  }
}
