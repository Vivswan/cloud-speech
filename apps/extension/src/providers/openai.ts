import { PROVIDER_COLORS } from "@cloud-speech/constants";
import { audioBytes, ProviderHttpError } from "@/lib/provider-http";
import {
  isQuotaExhaustedDetail,
  OPENAI_PROTOCOL_CAPABILITIES,
  OPENAI_VOICE_NAMES,
  synthesizeOpenAiSpeech,
} from "./openai-protocol";
import {
  FORMAT_MP3,
  FORMAT_OGG_OPUS,
  type ModelOptions,
  MULTILINGUAL,
  modelValues,
  type NormalizedVoice,
  type SynthResult,
  type TtsProvider,
} from "./types";

const API_BASE = "https://api.openai.com/v1";

const OPENAI_MODELS: ModelOptions = [
  { value: "gpt-4o-mini-tts", labelKey: "models.gpt_4o_mini_tts" },
  { value: "tts-1", labelKey: "models.tts_1" },
  { value: "tts-1-hd", labelKey: "models.tts_1_hd" },
];

function authHeaders(credentials: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${credentials.apiKey}`,
    "Content-Type": "application/json",
  };
}

// OpenAI has no voice-list API; the catalog is static and multilingual.
const STATIC_VOICES: NormalizedVoice[] = OPENAI_VOICE_NAMES.map((name) => ({
  id: name,
  providerId: "openai",
  displayName: name.charAt(0).toUpperCase() + name.slice(1),
  languageCodes: [MULTILINGUAL],
  gender: "Neutral",
  models: modelValues(OPENAI_MODELS),
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

  async validateAndFetchVoices(credentials, signal) {
    // /models succeeds for keys WITHOUT audio access, so the probe hits the speech endpoint with
    // the shortest input (fractions of a cent, only on Save & test).
    const response = await fetch(`${API_BASE}/audio/speech`, {
      method: "POST",
      headers: authHeaders(credentials),
      body: JSON.stringify({
        model: "gpt-4o-mini-tts",
        voice: "alloy",
        input: "Hi",
        response_format: "mp3",
      }),
      signal,
    });
    // A 2xx JSON or text body in place of audio (a quota notice behind the wrong status) fails
    // validation like a rejected key does.
    await audioBytes("openai", "validation", response);
    return this.fetchVoices(credentials);
  },

  async fetchVoices() {
    return STATIC_VOICES;
  },

  async synthesize(args): Promise<SynthResult> {
    return synthesizeOpenAiSpeech(this, args, {
      base: API_BASE,
      headers: authHeaders(args.credentials),
    });
  },

  ...OPENAI_PROTOCOL_CAPABILITIES,

  describeError(error) {
    if (
      error instanceof ProviderHttpError &&
      error.status === 429 &&
      isQuotaExhaustedDetail(error.detail)
    ) {
      return {
        kind: "quota_exhausted",
        actionUrl: "https://platform.openai.com/settings/organization/billing/overview",
      };
    }
    return undefined;
  },
};
