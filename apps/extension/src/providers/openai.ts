import { PROVIDER_COLORS } from "@cloud-speech/constants";
import { ProviderHttpError } from "@/lib/messaging/provider-http";
import {
  isQuotaExhaustedDetail,
  OPENAI_PROTOCOL_CAPABILITIES,
  OPENAI_VOICE_NAMES,
  openAiHeaders,
  probeOpenAiSpeech,
  synthesizeOpenAiSpeech,
} from "./openai-protocol";
import {
  FORMAT_MP3,
  FORMAT_OGG_OPUS,
  type ModelOptions,
  MULTILINGUAL,
  modelValues,
  type NormalizedVoice,
  positiveInteger,
  type SynthResult,
  type TtsProvider,
} from "./types";

const API_BASE = "https://api.openai.com/v1";

const OPENAI_MODELS: ModelOptions = [
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

  limits: { maxChars: positiveInteger(4096), concurrency: 2 },

  async validateAndFetchVoices(credentials, signal) {
    // /models succeeds for keys WITHOUT audio access, so the probe goes to the speech route.
    await probeOpenAiSpeech(
      this,
      { base: API_BASE, headers: openAiHeaders(credentials.apiKey) },
      OPENAI_MODELS[0].value,
      OPENAI_VOICE_NAMES[0],
      signal,
    );
    return this.fetchVoices(credentials);
  },

  async fetchVoices() {
    return STATIC_VOICES;
  },

  async synthesize(args): Promise<SynthResult> {
    return synthesizeOpenAiSpeech(this, args, {
      base: API_BASE,
      headers: openAiHeaders(args.credentials.apiKey),
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
