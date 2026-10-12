import { PROVIDER_COLORS } from "@cloud-speech/constants";
import { z } from "zod";
import { concatBytes, mapWithConcurrency } from "@/lib/audio/tts";
import { audioBytes, ProviderHttpError, providerHttpError } from "@/lib/messaging/provider-http";
import {
  chunkText,
  escapeXml,
  isSSML,
  signedDecibels,
  signedPercent,
  unwrapSpeak,
} from "@/lib/text/text";
import {
  type AudioFormat,
  type AudioFormats,
  characterBudget,
  DEFAULT_RANGES,
  effectiveFormat,
  FORMAT_MP3,
  FORMAT_MP3_64,
  FORMAT_OGG_OPUS,
  type NormalizedVoiceDraft,
  NormalizedVoiceSchema,
  type SynthResult,
  type TtsProvider,
} from "./types";

// Plain fetches, so a superseded read or preview cancels them.

interface AzureFormat extends AudioFormat {
  /** The X-Microsoft-OutputFormat header value. */
  readonly native: string;
}

const FORMATS: AudioFormats<AzureFormat> = [
  { ...FORMAT_MP3_64, native: "audio-16khz-64kbitrate-mono-mp3" },
  { ...FORMAT_MP3, native: "audio-16khz-32kbitrate-mono-mp3" },
  { ...FORMAT_OGG_OPUS, native: "ogg-16khz-16bit-mono-opus" },
];

/** Region ids are single hostname labels ("eastus", "westeurope"). */
const REGION_ID = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Sovereign clouds live under their own domains, keyed by region prefix. */
function hostSuffix(region: string): string {
  const lower = region.toLowerCase();
  if (lower.startsWith("china")) return "azure.cn";
  if (lower.startsWith("usgov")) return "azure.us";
  return "microsoft.com";
}

const VoicesResponseSchema = z.array(
  z.object({
    ShortName: z.string().min(1),
    LocalName: z.string().optional(),
    Locale: z.string().min(1),
    Gender: z.string().optional(),
    VoiceType: z.string().optional(),
    StyleList: z.array(z.string()).optional(),
  }),
);

function speakOpen(lang: string): string {
  return (
    '<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" ' +
    `xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${lang}">`
  );
}

/** "fr-FR-DeniseNeural" -> "fr-FR": the voice name is the last segment, the locale everything before it. */
export function localeFromShortName(shortName: string): string | null {
  const parts = shortName.split("-");
  if (parts.length < 3 || !/^[a-z]{2,3}$/i.test(parts[0] ?? "")) return null;
  return parts.slice(0, -1).join("-");
}

interface AzureProsody {
  speed: number;
  pitch: number;
  volumeGainDb: number;
  style?: string;
  language?: string;
}

/** Azure takes a RELATIVE rate percentage (+50% = 1.5x). */
export function buildSsml(text: string, voiceId: string, prosody: AzureProsody): string {
  const attributes: string[] = [];
  if (prosody.speed !== 1) {
    attributes.push(`rate="${signedPercent(Math.round((prosody.speed - 1) * 100))}"`);
  }
  if (prosody.pitch !== 0) {
    attributes.push(`pitch="${signedPercent(prosody.pitch)}"`);
  }
  if (prosody.volumeGainDb !== 0) {
    attributes.push(`volume="${signedDecibels(prosody.volumeGainDb)}"`);
  }

  const inner = isSSML(text) ? unwrapSpeak(text) : escapeXml(text);

  let body = inner;
  if (attributes.length > 0) {
    body = `<prosody ${attributes.join(" ")}>${body}</prosody>`;
  }
  if (prosody.style) {
    body = `<mstts:express-as style="${prosody.style}">${body}</mstts:express-as>`;
  }

  const lang = prosody.language ?? localeFromShortName(voiceId) ?? "en-US";
  return `${speakOpen(lang)}<voice name="${voiceId}">${body}</voice></speak>`;
}

/** endpoint()'s own refusal of the region, before any request goes out. */
export class AzureRegionError extends Error {
  override readonly name = "AzureRegionError";
  constructor(region: string) {
    super(region ? `Azure region "${region}" is invalid` : "Azure region is missing");
  }
}

/** A missing or malformed region is rejected by name: fetching `https://.tts.speech.microsoft.com`
 *  would only report an anonymous network failure. */
export function endpoint(credentials: Record<string, string>): string {
  const region = credentials.region?.trim() ?? "";
  if (!REGION_ID.test(region)) throw new AzureRegionError(region);
  return `https://${region}.tts.speech.${hostSuffix(region)}/cognitiveservices`;
}

function authHeaders(credentials: Record<string, string>): Record<string, string> {
  return { "Ocp-Apim-Subscription-Key": credentials.subscriptionKey ?? "" };
}

async function speakSsml(
  base: string,
  credentials: Record<string, string>,
  outputFormat: string,
  ssml: string,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const response = await fetch(`${base}/v1`, {
    method: "POST",
    headers: {
      ...authHeaders(credentials),
      "Content-Type": "application/ssml+xml",
      "X-Microsoft-OutputFormat": outputFormat,
    },
    body: ssml,
    signal,
  });
  return audioBytes("azure", "synthesis", response);
}

export const azure: TtsProvider = {
  id: "azure",
  labelKey: "providers.azure.name",
  color: PROVIDER_COLORS.azure,

  credentialSchema: [
    {
      key: "subscriptionKey",
      labelKey: "providers.azure.subscriptionKey",
      placeholder: "••••••••",
      type: "password",
    },
    {
      key: "region",
      role: "region",
      labelKey: "providers.azure.region",
      placeholder: "eastus",
      defaultValue: "eastus",
      type: "text",
      // Consoles display "East US"; the API wants the lowercase id.
      hintPattern: /^[a-z0-9-]+$/,
      hintKey: "settings.hint_region",
    },
  ],

  models: [
    {
      value: "neural",
      labelKey: "models.neural",
      descriptionKey: "models.neural_description",
    },
    {
      value: "standard",
      labelKey: "models.standard",
      descriptionKey: "models.standard_description",
    },
  ],

  audioFormats: FORMATS,

  limits: { chunkBudget: () => characterBudget(5000), concurrency: 4 },

  async fetchVoices(credentials, signal) {
    const response = await fetch(`${endpoint(credentials)}/voices/list`, {
      headers: authHeaders(credentials),
      signal,
    });
    if (!response.ok) throw await providerHttpError("azure", "voices", response);

    const voices = VoicesResponseSchema.parse(await response.json());
    return voices.map((voice) =>
      NormalizedVoiceSchema.parse({
        // ShortName (e.g. "en-US-JennyNeural") is what <voice name> accepts.
        id: voice.ShortName,
        providerId: "azure",
        displayName: voice.LocalName || voice.ShortName,
        languageCodes: [voice.Locale],
        gender: normalizeGender(voice.Gender),
        models: [voice.VoiceType === "Standard" ? "standard" : "neural"],
        styles: voice.StyleList ?? [],
      } satisfies NormalizedVoiceDraft),
    );
  },

  async synthesize(args): Promise<SynthResult> {
    const budget = this.limits.chunkBudget({ id: args.voiceId }, args.model);
    const chunks = chunkText(args.text, budget.limit, budget.sizeOf);
    const format = effectiveFormat(FORMATS, args.encoding, chunks.length);
    const base = endpoint(args.credentials);

    const byteChunks = await mapWithConcurrency(
      chunks,
      this.limits.concurrency,
      (chunk) =>
        speakSsml(
          base,
          args.credentials,
          format.native,
          buildSsml(chunk, args.voiceId, args),
          args.signal,
        ),
      args.signal,
      this,
    );

    return {
      bytes: concatBytes(byteChunks),
      mimeType: format.mimeType,
      extension: format.extension,
    };
  },

  supportsSpeed() {
    // Every Azure engine takes an SSML prosody rate.
    return true;
  },
  supportsPitch() {
    return true;
  },
  supportsVolume() {
    return true;
  },
  supportsStyle(voice, model) {
    return model === "neural" && (voice?.styles?.length ?? 0) > 0;
  },
  supportsSSML() {
    return true;
  },
  ranges() {
    return DEFAULT_RANGES;
  },

  // The region is part of the hostname: a well-formed but nonexistent one never answers.
  unreachableMessageKey: "errors.unreachable_region_message",
  describeError(error) {
    // A used-up quota (the F0 tier's monthly allowance) is a 403 too; the key is fine.
    if (error instanceof ProviderHttpError && error.status === 403 && /quota/i.test(error.detail)) {
      return { kind: "quota_exhausted", messageKey: "errors.quota_used_up_message" };
    }
    if (error instanceof AzureRegionError) {
      return { kind: "key_rejected", messageKey: "errors.region_invalid_message" };
    }
    return undefined;
  },
};

/** Azure reports "Male", "Female", or nothing useful. */
function normalizeGender(gender: string | undefined): string {
  return gender === "Male" || gender === "Female" ? gender : "Neutral";
}
