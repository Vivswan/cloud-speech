import { PROVIDER_COLORS } from "@cloud-speech/constants";
import { z } from "zod";
import { NO_AUDIO_DETAIL, ProviderHttpError, providerHttpError } from "@/lib/provider-http";
import { chunkText, isSSML, stripSsmlTags, utf8ByteLength } from "@/lib/text";
import { concatBytes, mapWithConcurrency } from "@/lib/tts";
import {
  DEFAULT_RANGES,
  effectiveFormat,
  FORMAT_MP3,
  FORMAT_OGG_OPUS,
  hasAllCredentialFields,
  type NormalizedVoiceDraft,
  NormalizedVoiceSchema,
  type SynthResult,
  type TtsProvider,
} from "./types";

// Google Cloud Text-to-Speech via REST (API-key auth); no Node SDK needed.

const API_BASE = "https://texttospeech.googleapis.com/v1";

const VoicesResponseSchema = z.object({
  voices: z.array(
    z.object({
      name: z.string(),
      languageCodes: z.array(z.string()),
      ssmlGender: z.string().optional(),
      naturalSampleRateHertz: z.number().optional(),
    }),
  ),
});

// `audioContent` is read as optional so a 2xx without it is reported as the
// service returning no audio, not as a malformed response.
const SynthesizeResponseSchema = z.object({
  audioContent: z.string().optional(),
});

/** Gemini-TTS voices are bare names ("Achernar"); classic ones embed a locale. */
export function isGeminiVoice(name: string): boolean {
  return !/^[a-z]{2,3}-/i.test(name);
}

/** Infer the model family (standard/wavenet/neural2/chirp/chirp3/gemini)
 *  from a voice name. Chirp 3 HD ("en-US-Chirp3-HD-Achernar") is its own
 *  family, apart from Chirp HD ("en-US-Chirp-HD-D"): it needs the Vertex AI
 *  API enabled on the project, so an availability scan must sample it
 *  separately. */
export function modelFromVoiceName(name: string): string {
  if (isGeminiVoice(name)) return "gemini";
  const lower = name.toLowerCase();
  if (/chirp[\s-]?3/.test(lower)) return "chirp3";
  if (lower.includes("chirp")) return "chirp";
  if (lower.includes("neural2")) return "neural2";
  if (lower.includes("wavenet")) return "wavenet";
  return "standard";
}

// Voice families that reject prosody/SSML parameters with a 400 instead of
// ignoring them, even when the value is the neutral default.
const NO_PITCH_VOICE = /chirp|journey|studio|news|casual|polyglot/i;
const NO_SSML_VOICE = /chirp|journey/i;
// The same rule by model family, for capability questions asked without a
// voice (both Chirp generations share the restrictions).
const NO_PITCH_MODELS = new Set(["chirp", "chirp3", "gemini"]);
const NO_SSML_MODELS = NO_PITCH_MODELS;

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export const google: TtsProvider = {
  id: "google",
  labelKey: "providers.google.name",
  color: PROVIDER_COLORS.google,

  credentialSchema: [
    {
      key: "apiKey",
      labelKey: "providers.google.apiKey",
      placeholder: "AIza...",
      type: "password",
      hintPattern: /^AIza/,
      hintKey: "settings.hint_key_shape",
    },
  ],

  models: [
    { value: "standard", labelKey: "models.standard" },
    { value: "wavenet", labelKey: "models.wavenet" },
    { value: "neural2", labelKey: "models.neural2" },
    { value: "chirp", labelKey: "models.chirp" },
    { value: "chirp3", labelKey: "models.chirp3" },
    { value: "gemini", labelKey: "models.gemini" },
  ],

  audioFormats: [FORMAT_MP3, FORMAT_OGG_OPUS],

  limits: { maxChars: 5000, concurrency: 4 },

  hasCredentials(credentials) {
    return hasAllCredentialFields(this.credentialSchema, credentials);
  },

  async validateAndFetchVoices(credentials, signal) {
    return this.fetchVoices(credentials, signal);
  },

  async fetchVoices(credentials, signal) {
    const response = await fetch(`${API_BASE}/voices`, {
      // Header auth keeps the key out of URLs (logs, referrers, history).
      headers: { "X-Goog-Api-Key": credentials.apiKey ?? "" },
      signal,
    });
    if (!response.ok) throw await providerHttpError("google", "voices", response);

    const parsed = VoicesResponseSchema.parse(await response.json());
    return parsed.voices.map((voice) =>
      NormalizedVoiceSchema.parse({
        id: voice.name,
        providerId: "google",
        displayName: voice.name,
        languageCodes: voice.languageCodes,
        gender: normalizeGender(voice.ssmlGender),
        models: [modelFromVoiceName(voice.name)],
        sampleRate: voice.naturalSampleRateHertz,
      } satisfies NormalizedVoiceDraft),
    );
  },

  async synthesize(args): Promise<SynthResult> {
    // Classic voices embed their locale ("en-US-Neural2-A"), Gemini voices
    // are bare star names ("Achernar"); never guess a locale from those.
    const gemini = isGeminiVoice(args.voiceId);
    const nameDerived = args.voiceId.split("-").slice(0, 2).join("-");
    const languageCode =
      args.language ?? (/^[a-z]{2,3}-[A-Za-z0-9]+$/.test(nameDerived) ? nameDerived : "en-US");
    // Google's limits are BYTES (4000 for Gemini, 5000 classic), so measure
    // chunks in UTF-8 bytes with a safety margin, not UTF-16 code units.
    const chunks = chunkText(args.text, gemini ? 3800 : 4800, utf8ByteLength);
    // Non-stitchable containers (Ogg) can't be byte-concatenated, so fall back
    // to a stitchable format when the text needed more than one chunk.
    const format = effectiveFormat(this.audioFormats, args.encoding, chunks.length);

    // Only send prosody values that differ from their neutral defaults:
    // restrictive voice families (Chirp, Journey, Studio, ...) 400 on the mere
    // presence of a parameter they don't support.
    const audioConfig: Record<string, unknown> = {
      audioEncoding: format.id === FORMAT_OGG_OPUS.id ? "OGG_OPUS" : "MP3",
    };
    if (!gemini) {
      if (args.speed !== 1) audioConfig.speakingRate = args.speed;
      if (args.pitch !== 0 && !NO_PITCH_VOICE.test(args.voiceId)) audioConfig.pitch = args.pitch;
      if (args.volumeGainDb !== 0) audioConfig.volumeGainDb = args.volumeGainDb;
    }

    // Gemini-TTS voices require the synthesis model alongside the voice name.
    const voice = gemini
      ? { languageCode, name: args.voiceId, model_name: "gemini-2.5-flash-tts" }
      : { languageCode, name: args.voiceId };

    const synthesizeChunk = async (chunk: string): Promise<Uint8Array> => {
      const response = await fetch(`${API_BASE}/text:synthesize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Header auth keeps the key out of URLs (logs, referrers, history).
          "X-Goog-Api-Key": args.credentials.apiKey ?? "",
        },
        signal: args.signal,
        body: JSON.stringify({
          input:
            isSSML(chunk) && !NO_SSML_VOICE.test(args.voiceId) && !gemini
              ? { ssml: chunk }
              : // SSML reaching a plain-text-only voice must be stripped, or
                // the markup gets spoken aloud.
                { text: isSSML(chunk) ? stripSsmlTags(chunk) : chunk },
          voice,
          audioConfig,
        }),
      });
      if (!response.ok) throw await providerHttpError("google", "synthesis", response);
      const parsed = SynthesizeResponseSchema.parse(await response.json());
      const bytes = base64ToBytes(parsed.audioContent ?? "");
      // Zero bytes would play as silence; name the empty answer instead.
      if (bytes.byteLength === 0) {
        throw new ProviderHttpError("google", "synthesis", response.status, NO_AUDIO_DETAIL);
      }
      return bytes;
    };
    const byteChunks = await mapWithConcurrency(
      chunks,
      this.limits.concurrency,
      synthesizeChunk,
      args.signal,
    );

    return {
      bytes: concatBytes(byteChunks),
      mimeType: format.mimeType,
      extension: format.extension,
    };
  },

  supportsSpeed(voice, model) {
    // speakingRate is only sent on the non-Gemini path (see synthesize).
    if (voice && isGeminiVoice(voice.id)) return false;
    return model !== "gemini";
  },
  supportsPitch(voice, model) {
    if (voice && (NO_PITCH_VOICE.test(voice.id) || isGeminiVoice(voice.id))) return false;
    return !NO_PITCH_MODELS.has(model);
  },
  supportsVolume(voice, model) {
    if (voice && isGeminiVoice(voice.id)) return false;
    return model !== "gemini";
  },
  supportsStyle() {
    return false;
  },
  supportsSSML(voice, model) {
    if (voice && (NO_SSML_VOICE.test(voice.id) || isGeminiVoice(voice.id))) return false;
    return !NO_SSML_MODELS.has(model);
  },
  ranges() {
    return {
      ...DEFAULT_RANGES,
      speed: { min: 0.25, max: 4, default: 1, step: 0.05 },
    };
  },

  describeError(error) {
    if (!(error instanceof ProviderHttpError)) return undefined;
    // SERVICE_DISABLED: a Gemini voice on a project without the Vertex AI
    // ("Agent Platform") API, or a fresh key before the TTS API is on. The
    // body names the API and links its console page; hand both over.
    const disabled = API_DISABLED.exec(error.detail);
    if (disabled?.[1]) {
      return {
        kind: "api_disabled",
        feature: disabled[1],
        actionUrl: CONSOLE_URL.exec(error.detail)?.[0],
      };
    }
    // BILLING_DISABLED: the same account-side switch, with its own page.
    if (/requires billing to be enabled/i.test(error.detail)) {
      return {
        kind: "api_disabled",
        messageKey: "errors.billing_disabled_message",
        actionUrl: CONSOLE_URL.exec(error.detail)?.[0],
      };
    }
    // A malformed or expired key is a 400, not a 401.
    if (/API key (?:not valid|expired)/i.test(error.detail)) return { kind: "key_rejected" };
    return undefined;
  },
};

const API_DISABLED =
  /([A-Z][A-Za-z0-9 -]*?) has not been used in project \S+ before or it is disabled/;
const CONSOLE_URL =
  /https:\/\/console\.(?:developers|cloud)\.google\.com\/[^\s)]+?(?=[.,;)]*(?:\s|$))/;

function normalizeGender(gender: string | undefined): string {
  if (!gender) return "Neutral";
  const lower = gender.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
