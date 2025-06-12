import winkNLP from 'wink-nlp'
import model from 'wink-eng-lite-web-model'
import he from 'he'

const nlp = winkNLP(model)

String.prototype.chunk = function() {
  if (this.isSSML()) return this.chunkSSML()

  return nlp.readDoc(this as string).sentences().out()
}


String.prototype.chunkSSML = function() {
  const maxChunkSize = 5000
  const speakStartTag = '<speak>'
  const speakEndTag = '</speak>'
  const chunks = []
  let currentChunk = ''

  const content = this.slice(speakStartTag.length, -speakEndTag.length)

  const regex = /(<[^>]*>|[^<]+)/g
  let match

  while ((match = regex.exec(content)) !== null) {
    const element = match[0]

    if (currentChunk.length + element.length > maxChunkSize - (speakStartTag.length + speakEndTag.length)) {
      chunks.push(speakStartTag + currentChunk + speakEndTag)
      currentChunk = ''
    }

    currentChunk += element
  }

  if (currentChunk) {
    chunks.push(speakStartTag + currentChunk + speakEndTag)
  }

  return chunks
}

String.prototype.isSSML = function() {
  const trimmedText = this.trim()
  return trimmedText.startsWith('<speak>') && trimmedText.endsWith('</speak>')
}

/**
 * Sanitizes text for safe use in SSML synthesis
 * - If text is already valid SSML, returns it as-is
 * - Otherwise, removes HTML tags and escapes XML special characters
 * - Preserves line breaks and basic formatting
 */
export function sanitizeTextForSSML(text: string): string {
  if (!text) return ''

  // If text is already valid SSML, return as-is
  if (text.trim().startsWith('<speak>') && text.trim().endsWith('</speak>')) {
    return text
  }

  // Remove HTML tags but preserve content
  let sanitized = text
    // Remove common HTML tags but keep their content
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '') // Remove script tags entirely
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '') // Remove style tags entirely
    // More careful HTML tag removal - only remove if it looks like a real HTML tag
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*[^<>]*>/g, ' ') // Remove HTML tags (must start with letter)
    // Clean up whitespace
    .replace(/\s+/g, ' ') // Replace multiple spaces with single space
    .replace(/\n\s*\n/g, '\n') // Replace multiple newlines with single newline
    .trim()

  // Decode HTML entities first (e.g., &amp; -> &, &lt; -> <)
  sanitized = he.decode(sanitized)

  // Then escape XML special characters for SSML safety
  // Only escape the characters that are problematic for XML/SSML: < > & " '
  sanitized = sanitized
    .replace(/&/g, '&#x26;')   // & must be escaped first
    .replace(/</g, '&#x3C;')   // < 
    .replace(/>/g, '&#x3E;')   // >
    .replace(/"/g, '&#x22;')   // "
    .replace(/'/g, '&#x27;')   // '

  return sanitized
}
