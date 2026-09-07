import { PROVIDER_COLORS } from "@cloud-speech/constants";
import { z } from "zod";
import { providerHttpError } from "@/lib/provider-http";
import { chunkText, escapeXml, isSSML } from "@/lib/text";
import { concatBytes, mapWithConcurrency } from "@/lib/tts";
import {
  DEFAULT_RANGES,
  effectiveFormat,
  FORMAT_MP3,
  FORMAT_MP3_64,
  FORMAT_OGG_OPUS,
  hasAllCredentialFields,
  type NormalizedVoiceDraft,
  NormalizedVoiceSchema,
  type SynthResult,
  type TtsProvider,
} from "./types";

// Azure Speech text-to-speech via its REST API (subscription-key auth). The
// requests are plain fetches, so a superseded read or preview cancels them.

/** X-Microsoft-OutputFormat names, keyed by AudioFormat id. */
const DEFAULT_OUTPUT_FORMAT = "audio-16khz-64kbitrate-mono-mp3";
const FORMAT_MAP: Record<string, string> = {
  [FORMAT_MP3.id]: "audio-16khz-32kbitrate-mono-mp3",
  [FORMAT_MP3_64.id]: DEFAULT_OUTPUT_FORMAT,
  [FORMAT_OGG_OPUS.id]: "ogg-16khz-16bit-mono-opus",
};

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

/** Derive the BCP-47 locale from an Azure shortName ("fr-FR-DeniseNeural" → "fr-FR"). */
export function localeFromShortName(shortName: string): string | null {
  // shortName = <locale segments>-<VoiceName>; the voice name is the last segment.
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

/**
 * Build a complete Azure SSML document: `<speak>` wrapper, `<voice name>`,
 * optional `<mstts:express-as>` style, and a prosody tag. Azure uses a
 * RELATIVE rate percentage (`+50%` = 1.5x speed). The `xml:lang` comes from
 * the selected voice's language, else the voice shortName, else "en-US".
 */
export function buildSsml(text: string, voiceId: string, prosody: AzureProsody): string {
  const attributes: string[] = [];
  if (prosody.speed !== 1) {
    const percent = Math.round((prosody.speed - 1) * 100);
    const sign = percent >= 0 ? "+" : "";
    attributes.push(`rate="${sign}${percent}%"`);
  }
  if (prosody.pitch !== 0) {
    const sign = prosody.pitch >= 0 ? "+" : "";
    attributes.push(`pitch="${sign}${prosody.pitch}%"`);
  }
  if (prosody.volumeGainDb !== 0) {
    const sign = prosody.volumeGainDb >= 0 ? "+" : "";
    attributes.push(`volume="${sign}${prosody.volumeGainDb}dB"`);
  }

  // Plain text is XML-escaped before embedding; existing SSML keeps its markup.
  const inner = isSSML(text)
    ? text.trim().replace(/<speak[^>]*>(.*)<\/speak>/s, "$1")
    : escapeXml(text);

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

/** The regional TTS endpoint. A missing or malformed region is rejected here,
 *  by name: fetching `https://.tts.speech.microsoft.com` would only report an
 *  anonymous network failure. */
export function endpoint(credentials: Record<string, string>): string {
  const region = credentials.region?.trim() ?? "";
  if (!region) throw new Error("Azure region is missing");
  if (!REGION_ID.test(region)) throw new Error(`Azure region "${region}" is invalid`);
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
  if (!response.ok) throw await providerHttpError("azure", "synthesis", response);
  return new Uint8Array(await response.arrayBuffer());
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

  audioFormats: [FORMAT_MP3_64, FORMAT_MP3, FORMAT_OGG_OPUS],

  limits: { maxChars: 5000, concurrency: 4 },

  hasCredentials(credentials) {
    return hasAllCredentialFields(this.credentialSchema, credentials);
  },

  async validateAndFetchVoices(credentials, signal) {
    return this.fetchVoices(credentials, signal);
  },

  async fetchVoices(credentials, signal) {
    const response = await fetch(`${endpoint(credentials)}/voices/list`, {
      headers: authHeaders(credentials),
      signal,
    });
    if (!response.ok) throw await providerHttpError("azure", "voices", response);

    const voices = VoicesResponseSchema.parse(await response.json());
    if (voices.length === 0) throw new Error("No voices returned by Azure");

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
    const chunks = chunkText(args.text, this.limits.maxChars);
    // Non-stitchable containers (Ogg) can't be byte-concatenated, so fall back
    // to a stitchable format when the text needed more than one chunk.
    const format = effectiveFormat(this.audioFormats, args.encoding, chunks.length);
    const outputFormat = FORMAT_MAP[format.id] ?? DEFAULT_OUTPUT_FORMAT;
    const base = endpoint(args.credentials);

    const byteChunks = await mapWithConcurrency(
      chunks,
      this.limits.concurrency,
      (chunk) =>
        speakSsml(
          base,
          args.credentials,
          outputFormat,
          buildSsml(chunk, args.voiceId, args),
          args.signal,
        ),
      args.signal,
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
};

/** Azure reports "Male", "Female", or nothing useful. */
function normalizeGender(gender: string | undefined): string {
  return gender === "Male" || gender === "Female" ? gender : "Neutral";
}
