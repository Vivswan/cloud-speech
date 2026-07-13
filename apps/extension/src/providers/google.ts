import { z } from "zod";
import { chunkText, isSSML, stripSsmlTags, utf8ByteLength } from "@/lib/text";
import { concatBytes, mapWithConcurrency } from "@/lib/tts";
import {
  DEFAULT_RANGES,
  effectiveFormat,
  hasAllCredentialFields,
  type NormalizedVoice,
  NormalizedVoiceSchema,
  type SynthResult,
  type TtsProvider,
} from "./types";

// Google Cloud Text-to-Speech via REST (API-key auth); no Node SDK needed.

const API_BASE = "https://texttospeech.googleapis.com/v1";

import { guideUrl } from "@/lib/guide";

// Step-by-step setup guide for non-developers (extension website).
const CREDENTIAL_HELP_URL = guideUrl("setup/google");

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

const SynthesizeResponseSchema = z.object({
  audioContent: z.string(),
});

/** Gemini-TTS voices are bare names ("Achernar"); classic ones embed a locale. */
export function isGeminiVoice(name: string): boolean {
  return !/^[a-z]{2,3}-/i.test(name);
}

/** Infer the model family (standard/wavenet/neural2/chirp/gemini) from a voice name. */
export function modelFromVoiceName(name: string): string {
  if (isGeminiVoice(name)) return "gemini";
  const lower = name.toLowerCase();
  if (lower.includes("chirp")) return "chirp";
  if (lower.includes("neural2")) return "neural2";
  if (lower.includes("wavenet")) return "wavenet";
  return "standard";
}

// Voice families that reject prosody/SSML parameters with a 400 instead of
// ignoring them, even when the value is the neutral default.
const NO_PITCH_VOICE = /chirp|journey|studio|news|casual|polyglot/i;
const NO_SSML_VOICE = /chirp|journey/i;

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
  color: "#DB4437",

  credentialSchema: [
    {
      key: "apiKey",
      labelKey: "providers.google.apiKey",
      placeholder: "AIza...",
      type: "password",
      helpUrl: CREDENTIAL_HELP_URL,
      hintPattern: /^AIza/,
      hintKey: "settings.hint_key_shape",
    },
  ],

  models: [
    { value: "standard", labelKey: "models.standard" },
    { value: "wavenet", labelKey: "models.wavenet" },
    { value: "neural2", labelKey: "models.neural2" },
    { value: "chirp", labelKey: "models.chirp" },
    { value: "gemini", labelKey: "models.gemini" },
  ],

  audioFormats: [
    {
      id: "MP3",
      mimeType: "audio/mpeg",
      extension: "mp3",
      stitchable: true,
      forDownload: true,
      forReadAloud: true,
    },
    {
      id: "OGG_OPUS",
      mimeType: "audio/ogg",
      extension: "ogg",
      stitchable: false,
      forDownload: false,
      forReadAloud: true,
    },
  ],

  limits: { maxChars: 5000, concurrency: 4 },

  hasCredentials(credentials) {
    return hasAllCredentialFields(this.credentialSchema, credentials);
  },

  async validateAndFetchVoices(credentials) {
    return this.fetchVoices(credentials);
  },

  async fetchVoices(credentials) {
    const response = await fetch(`${API_BASE}/voices`, {
      // Header auth keeps the key out of URLs (logs, referrers, history).
      headers: { "X-Goog-Api-Key": credentials.apiKey ?? "" },
    });
    if (!response.ok) {
      throw new Error(`Google TTS voices request failed: ${response.status}`);
    }

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
      } satisfies NormalizedVoice),
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
    if (!format) throw new Error("No audio format available");

    // Only send prosody values that differ from their neutral defaults:
    // restrictive voice families (Chirp, Journey, Studio, ...) 400 on the mere
    // presence of a parameter they don't support.
    const audioConfig: Record<string, unknown> = {
      audioEncoding: format.id === "OGG_OPUS" ? "OGG_OPUS" : "MP3",
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

    const byteChunks = await mapWithConcurrency(chunks, this.limits.concurrency, async (chunk) => {
      const response = await fetch(`${API_BASE}/text:synthesize`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          // Header auth keeps the key out of URLs (logs, referrers, history).
          "X-Goog-Api-Key": args.credentials.apiKey ?? "",
        },
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
      if (!response.ok) {
        let detail = "";
        try {
          const body: unknown = await response.json();
          if (body && typeof body === "object" && "error" in body) {
            const err = (body as { error?: { message?: string } }).error;
            detail = err?.message ?? "";
          }
        } catch {
          // Non-JSON error body; the status code will have to do.
        }
        throw new Error(
          `Google TTS synthesis failed: ${response.status}${detail ? ` (${detail})` : ""}`,
        );
      }
      const parsed = SynthesizeResponseSchema.parse(await response.json());
      return base64ToBytes(parsed.audioContent);
    });

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
    return model !== "chirp" && model !== "gemini";
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
    return model !== "chirp" && model !== "gemini";
  },
  ranges() {
    return {
      ...DEFAULT_RANGES,
      speed: { min: 0.25, max: 4, default: 1, step: 0.05 },
    };
  },
};

function normalizeGender(gender: string | undefined): string {
  if (!gender) return "Neutral";
  const lower = gender.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
