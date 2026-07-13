import {
  DescribeVoicesCommand,
  Engine,
  OutputFormat,
  PollyClient,
  type Voice as PollyVoice,
  SynthesizeSpeechCommand,
  TextType,
  type VoiceId,
} from "@aws-sdk/client-polly";
import { guideUrl } from "@/lib/guide";
import { chunkText, escapeXml, isSSML, stripSsmlTags } from "@/lib/text";
import { concatBytes, mapWithConcurrency } from "@/lib/tts";
import {
  DEFAULT_RANGES,
  effectiveFormat,
  hasAllCredentialFields,
  type NormalizedVoice,
  NormalizedVoiceSchema,
  type SynthesizeArgs,
  type SynthResult,
  type TtsProvider,
} from "./types";

// Step-by-step setup guide for non-developers (extension website).
const CREDENTIAL_HELP_URL = guideUrl("setup/polly");

const FORMAT_MAP: Record<string, OutputFormat> = {
  MP3: OutputFormat.MP3,
  MP3_64_KBPS: OutputFormat.MP3,
  OGG_OPUS: OutputFormat.OGG_VORBIS,
};

const ENGINE_MAP: Record<string, Engine> = {
  standard: Engine.STANDARD,
  neural: Engine.NEURAL,
  generative: Engine.GENERATIVE,
  "long-form": Engine.LONG_FORM,
};

/** Engines that accept SSML prosody markup. Generative/long-form voices reject it. */
const SSML_ENGINES = new Set(["standard", "neural"]);

interface PollyProsody {
  speed: number;
  pitch: number;
  volumeGainDb: number;
}

/**
 * Wrap text (or an existing `<speak>` document) with a Polly prosody tag.
 * Plain text is XML-escaped before being embedded. Polly uses an ABSOLUTE
 * rate percentage (100% = normal speed).
 * Returns null when the request must go out as plain TEXT instead of SSML
 * (no prosody needed, or the engine rejects SSML entirely).
 */
export function buildSsml(text: string, model: string, prosody: PollyProsody): string | null {
  if (!SSML_ENGINES.has(model)) return null;

  const attributes: string[] = [];
  if (prosody.speed !== 1) {
    // Polly rejects prosody rates above 200%; defense in depth on top of
    // the UI/synthesis clamp from ranges().
    const speed = Math.min(2, Math.max(0.2, prosody.speed));
    attributes.push(`rate="${Math.round(speed * 100)}%"`);
  }
  if (prosody.pitch !== 0 && model === "standard") {
    const sign = prosody.pitch >= 0 ? "+" : "";
    attributes.push(`pitch="${sign}${prosody.pitch}%"`);
  }
  if (prosody.volumeGainDb !== 0) {
    const sign = prosody.volumeGainDb >= 0 ? "+" : "";
    attributes.push(`volume="${sign}${prosody.volumeGainDb}dB"`);
  }

  if (attributes.length === 0) {
    return isSSML(text) ? text : null;
  }

  const prosodyTag = `<prosody ${attributes.join(" ")}>`;
  if (isSSML(text)) {
    return text.replace(/<speak[^>]*>(.*)<\/speak>/s, `<speak>${prosodyTag}$1</prosody></speak>`);
  }
  return `<speak>${prosodyTag}${escapeXml(text)}</prosody></speak>`;
}

function createClient(credentials: Record<string, string>): PollyClient {
  return new PollyClient({
    region: credentials.region,
    credentials: {
      accessKeyId: credentials.accessKeyId ?? "",
      secretAccessKey: credentials.secretAccessKey ?? "",
    },
  });
}

async function synthesizeChunk(
  client: PollyClient,
  text: string,
  args: SynthesizeArgs,
  encoding: string,
): Promise<Uint8Array> {
  const ssml = buildSsml(text, args.model, args);
  // Plain-TEXT requests must not contain SSML markup (generative/long-form
  // engines reject it), so strip tags when SSML input hits a non-SSML path.
  const plain = isSSML(text) ? stripSsmlTags(text) : text;

  const response = await client.send(
    new SynthesizeSpeechCommand({
      OutputFormat: FORMAT_MAP[encoding] ?? OutputFormat.MP3,
      Text: ssml ?? plain,
      TextType: (ssml ? TextType.SSML : TextType.TEXT) as TextType,
      VoiceId: args.voiceId as VoiceId,
      Engine: ENGINE_MAP[args.model.toLowerCase()] ?? Engine.STANDARD,
    }),
  );

  if (!response.AudioStream) {
    throw new Error("No audio stream received from Polly");
  }
  return response.AudioStream.transformToByteArray();
}

export const polly: TtsProvider = {
  id: "polly",
  labelKey: "providers.polly.name",
  color: "#FF9900",

  credentialSchema: [
    {
      key: "accessKeyId",
      labelKey: "providers.polly.accessKeyId",
      placeholder: "AKIA...",
      type: "password",
      helpUrl: CREDENTIAL_HELP_URL,
      // Key ids are uppercase (AKIA/ASIA/...); catches the classic paste of the
      // 40-char mixed-case SECRET into this box before a doomed live test.
      hintPattern: /^A[A-Z0-9]{19,}$/,
      hintKey: "settings.hint_key_shape",
    },
    {
      key: "secretAccessKey",
      labelKey: "providers.polly.secretAccessKey",
      placeholder: "••••••••",
      type: "password",
      helpUrl: CREDENTIAL_HELP_URL,
    },
    {
      key: "region",
      labelKey: "providers.polly.region",
      placeholder: "us-east-1",
      defaultValue: "us-east-1",
      type: "text",
      helpUrl: CREDENTIAL_HELP_URL,
      // Consoles display "US East (N. Virginia)"; the SDK wants the id.
      hintPattern: /^[a-z0-9-]+$/,
      hintKey: "settings.hint_region",
    },
  ],

  models: [
    {
      value: "standard",
      labelKey: "models.standard",
      descriptionKey: "models.standard_description",
    },
    { value: "neural", labelKey: "models.neural", descriptionKey: "models.neural_description" },
    {
      value: "generative",
      labelKey: "models.generative",
      descriptionKey: "models.generative_description",
    },
    {
      value: "long-form",
      labelKey: "models.long_form",
      descriptionKey: "models.long_form_description",
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

  limits: { maxChars: 3000, concurrency: 4 },

  hasCredentials(credentials) {
    return hasAllCredentialFields(this.credentialSchema, credentials);
  },

  async validateAndFetchVoices(credentials) {
    return this.fetchVoices(credentials);
  },

  async fetchVoices(credentials) {
    const client = createClient(credentials);
    try {
      // DescribeVoices paginates; collect every page.
      const voices: PollyVoice[] = [];
      let nextToken: string | undefined;
      do {
        const response = await client.send(new DescribeVoicesCommand({ NextToken: nextToken }));
        voices.push(...(response.Voices ?? []));
        nextToken = response.NextToken;
      } while (nextToken);

      if (voices.length === 0) throw new Error("No voices returned by Polly");

      return voices.map((voice) =>
        NormalizedVoiceSchema.parse({
          id: voice.Id ?? "",
          providerId: "polly",
          displayName: voice.Id ?? "",
          languageCodes: [voice.LanguageCode ?? ""],
          gender: normalizeGender(voice.Gender),
          models: voice.SupportedEngines ?? ["standard"],
          sampleRate: 22050,
        } satisfies NormalizedVoice),
      );
    } finally {
      client.destroy();
    }
  },

  async synthesize(args): Promise<SynthResult> {
    const chunks = chunkText(args.text, this.limits.maxChars);
    // Non-stitchable containers (Ogg) can't be byte-concatenated, so fall back
    // to a stitchable format when the text needed more than one chunk.
    const format = effectiveFormat(this.audioFormats, args.encoding, chunks.length);
    if (!format) throw new Error("No audio format available");

    const client = createClient(args.credentials);
    try {
      const byteChunks = await mapWithConcurrency(chunks, this.limits.concurrency, (chunk) =>
        synthesizeChunk(client, chunk, args, format.id),
      );
      return {
        bytes: concatBytes(byteChunks),
        mimeType: format.mimeType,
        extension: format.extension,
      };
    } finally {
      client.destroy();
    }
  },

  supportsSpeed(_voice, model) {
    // Rate is expressed via SSML prosody, which generative/long-form reject.
    return SSML_ENGINES.has(model);
  },
  supportsPitch(_voice, model) {
    return model === "standard";
  },
  supportsVolume(_voice, model) {
    return SSML_ENGINES.has(model);
  },
  supportsStyle() {
    return false;
  },
  supportsSSML(_voice, model) {
    return SSML_ENGINES.has(model);
  },
  ranges() {
    // Polly caps prosody rate at 200%: a 3x slider value would synthesize a
    // rejected rate="300%". Everything else follows the defaults.
    return {
      ...DEFAULT_RANGES,
      speed: { min: 0.5, max: 2, default: 1, step: 0.05 },
    };
  },
};

function normalizeGender(gender: string | undefined): string {
  if (!gender) return "Neutral";
  const lower = gender.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}
