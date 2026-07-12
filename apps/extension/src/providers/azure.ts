import * as sdk from "microsoft-cognitiveservices-speech-sdk";
import { guideUrl } from "@/lib/guide";
import { chunkText, escapeXml, isSSML } from "@/lib/text";
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

// Step-by-step setup guide for non-developers (extension website).
const CREDENTIAL_HELP_URL = guideUrl("setup/azure");

const FORMAT_MAP: Record<string, sdk.SpeechSynthesisOutputFormat> = {
  MP3: sdk.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3,
  MP3_64_KBPS: sdk.SpeechSynthesisOutputFormat.Audio16Khz64KBitRateMonoMp3,
  OGG_OPUS: sdk.SpeechSynthesisOutputFormat.Ogg16Khz16BitMonoOpus,
};

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
 * RELATIVE rate percentage (`+50%` = 1.5× speed). The `xml:lang` comes from
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

function createConfig(credentials: Record<string, string>, encoding?: string): sdk.SpeechConfig {
  const config = sdk.SpeechConfig.fromSubscription(
    credentials.subscriptionKey ?? "",
    credentials.region ?? "",
  );
  if (encoding) {
    config.speechSynthesisOutputFormat =
      FORMAT_MAP[encoding] ?? sdk.SpeechSynthesisOutputFormat.Audio16Khz64KBitRateMonoMp3;
  }
  return config;
}

function speakSsml(config: sdk.SpeechConfig, ssml: string): Promise<Uint8Array> {
  const synthesizer = new sdk.SpeechSynthesizer(config, null as unknown as sdk.AudioConfig);
  return new Promise<Uint8Array>((resolve, reject) => {
    synthesizer.speakSsmlAsync(
      ssml,
      (result) => {
        synthesizer.close();
        if (result.reason === sdk.ResultReason.SynthesizingAudioCompleted) {
          resolve(new Uint8Array(result.audioData));
        } else {
          reject(
            new Error(
              `Speech synthesis failed: ${result.errorDetails || sdk.ResultReason[result.reason]}`,
            ),
          );
        }
      },
      (error) => {
        synthesizer.close();
        reject(new Error(String(error)));
      },
    );
  });
}

export const azure: TtsProvider = {
  id: "azure",
  labelKey: "providers.azure.name",
  color: "#0078D4",

  credentialSchema: [
    {
      key: "subscriptionKey",
      labelKey: "providers.azure.subscriptionKey",
      placeholder: "••••••••",
      type: "password",
      helpUrl: CREDENTIAL_HELP_URL,
    },
    {
      key: "region",
      labelKey: "providers.azure.region",
      placeholder: "eastus",
      type: "text",
      helpUrl: CREDENTIAL_HELP_URL,
    },
  ],

  models: [
    { value: "neural", labelKey: "models.neural", descriptionKey: "models.neural_description" },
    {
      value: "standard",
      labelKey: "models.standard",
      descriptionKey: "models.standard_description",
    },
  ],

  audioFormats: [
    {
      id: "MP3_64_KBPS",
      mimeType: "audio/mpeg",
      extension: "mp3",
      stitchable: true,
      forDownload: true,
      forReadAloud: true,
    },
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

  async validateCredentials(credentials) {
    try {
      const voices = await this.fetchVoices(credentials);
      return voices.length > 0;
    } catch {
      return false;
    }
  },

  async fetchVoices(credentials) {
    const config = createConfig(credentials);
    const synthesizer = new sdk.SpeechSynthesizer(config, null as unknown as sdk.AudioConfig);
    try {
      const result = await synthesizer.getVoicesAsync();
      if (!result.voices || result.voices.length === 0) {
        throw new Error(result.errorDetails || "No voices returned by Azure");
      }

      return result.voices.map((voice) =>
        NormalizedVoiceSchema.parse({
          // shortName (e.g. "en-US-JennyNeural") is what speechSynthesisVoiceName accepts.
          id: voice.shortName,
          providerId: "azure",
          displayName: voice.localName || voice.shortName,
          languageCodes: [voice.locale],
          gender: normalizeGender(voice.gender),
          models: [
            voice.voiceType === sdk.SynthesisVoiceType.OnlineStandard ? "standard" : "neural",
          ],
          styles: voice.styleList ?? [],
        } satisfies NormalizedVoice),
      );
    } finally {
      synthesizer.close();
    }
  },

  async synthesize(args): Promise<SynthResult> {
    const chunks = chunkText(args.text, this.limits.maxChars);
    // Non-stitchable containers (Ogg) can't be byte-concatenated — fall back
    // to a stitchable format when the text needed more than one chunk.
    const format = effectiveFormat(this.audioFormats, args.encoding, chunks.length);
    if (!format) throw new Error("No audio format available");

    const config = createConfig(args.credentials, format.id);

    const byteChunks = await mapWithConcurrency(chunks, this.limits.concurrency, (chunk) =>
      speakSsml(config, buildSsml(chunk, args.voiceId, args)),
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

function normalizeGender(gender: sdk.SynthesisVoiceGender): string {
  switch (gender) {
    case sdk.SynthesisVoiceGender.Male:
      return "Male";
    case sdk.SynthesisVoiceGender.Female:
      return "Female";
    default:
      return "Neutral";
  }
}
