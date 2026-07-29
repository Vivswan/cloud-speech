import { PROVIDER_COLORS } from "@cloud-speech/constants";
import { chunkText, isSSML, stripSsmlTags } from "@/lib/text";
import { concatBytes, mapWithConcurrency } from "@/lib/tts";
import { OPENAI_VOICE_NAMES, toOpenAiResponseFormat } from "./openai-protocol";
import {
  DEFAULT_RANGES,
  effectiveFormat,
  FORMAT_MP3,
  FORMAT_OGG_OPUS,
  hasAllCredentialFields,
  type ModelOption,
  MULTILINGUAL,
  type NormalizedVoice,
  type SynthResult,
  type TtsProvider,
} from "./types";

// OpenAI text-to-speech via REST (Bearer API key); no SDK needed.

const API_BASE = "https://api.openai.com/v1";

const OPENAI_MODELS: ModelOption[] = [
  { value: "gpt-4o-mini-tts", labelKey: "models.gpt_4o_mini_tts" },
  { value: "tts-1", labelKey: "models.tts_1" },
  { value: "tts-1-hd", labelKey: "models.tts_1_hd" },
];

// OpenAI has no voice-list API; the catalog is static and multilingual.
const STATIC_VOICES: NormalizedVoice[] = OPENAI_VOICE_NAMES.map((name) => ({
  id: name,
  providerId: "openai",
  displayName: name.charAt(0).toUpperCase() + name.slice(1),
  languageCodes: [MULTILINGUAL],
  gender: "Neutral",
  models: OPENAI_MODELS.map((model) => model.value),
}));

export const openai: TtsProvider = {
  id: "openai",
  labelKey: "providers.openai.name",
  color: PROVIDER_COLORS.openai,

  credentialSchema: [
    {
      key: "apiKey",
      labelKey: "providers.openai.apiKey",
      placeholder: "sk-...",
      type: "password",
      // Warn-only: OpenAI already moved sk- to sk-proj- once; never block.
      hintPattern: /^sk-/,
      hintKey: "settings.hint_key_shape",
    },
  ],

  models: OPENAI_MODELS,

  audioFormats: [FORMAT_MP3, FORMAT_OGG_OPUS],

  limits: { maxChars: 4096, concurrency: 2 },

  hasCredentials(credentials) {
    return hasAllCredentialFields(this.credentialSchema, credentials);
  },

  async validateAndFetchVoices(credentials) {
    // /models succeeds for keys WITHOUT audio access, so probe the actual
    // speech endpoint with the shortest possible input instead (fractions of
    // a cent, and only when the user clicks Save & test).
    const response = await fetch(`${API_BASE}/audio/speech`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: "Hi",
        response_format: "mp3",
      }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI TTS validation failed: ${response.status}`);
    }
    return this.fetchVoices(credentials);
  },

  async fetchVoices() {
    return STATIC_VOICES;
  },

  async synthesize(args): Promise<SynthResult> {
    const chunks = chunkText(args.text, this.limits.maxChars);
    // Non-stitchable containers (Ogg) can't be byte-concatenated, so fall back
    // to a stitchable format when the text needed more than one chunk.
    const format = effectiveFormat(this.audioFormats, args.encoding, chunks.length);

    const byteChunks = await mapWithConcurrency(chunks, this.limits.concurrency, async (chunk) => {
      const response = await fetch(`${API_BASE}/audio/speech`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${args.credentials.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: args.model,
          voice: args.voiceId,
          // OpenAI has no SSML path; strip markup or it gets spoken aloud.
          input: isSSML(chunk) ? stripSsmlTags(chunk) : chunk,
          response_format: toOpenAiResponseFormat(format.id),
          speed: args.speed,
        }),
      });
      if (!response.ok) {
        throw new Error(`OpenAI TTS synthesis failed: ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    });

    return {
      bytes: concatBytes(byteChunks),
      mimeType: format.mimeType,
      extension: format.extension,
    };
  },

  supportsSpeed() {
    // `speed` is sent on every request and accepted by every model.
    return true;
  },
  supportsPitch() {
    return false;
  },
  supportsVolume() {
    return false;
  },
  supportsStyle() {
    return false;
  },
  supportsSSML() {
    return false;
  },
  ranges() {
    return {
      ...DEFAULT_RANGES,
      speed: { min: 0.25, max: 4, default: 1, step: 0.05 },
    };
  },
};
