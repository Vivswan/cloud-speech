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
import { PROVIDER_COLORS } from "@cloud-speech/constants";
import { concatBytes, mapWithConcurrency } from "@/lib/audio/tts";
import {
  failureKindForStatus,
  NO_AUDIO_DETAIL,
  ProviderHttpError,
} from "@/lib/messaging/provider-http";
import {
  chunkText,
  escapeXml,
  isSSML,
  signedDecibels,
  signedPercent,
  stripSsmlTags,
  unwrapSpeak,
} from "@/lib/text/text";
import {
  type AudioFormat,
  type AudioFormats,
  characterBudget,
  DEFAULT_RANGES,
  type ErrorDescription,
  effectiveFormat,
  FORMAT_MP3,
  FORMAT_MP3_64,
  FORMAT_OGG_OPUS,
  type NormalizedVoiceDraft,
  NormalizedVoiceSchema,
  normalizeGender,
  type SynthesizeArgs,
  type SynthResult,
  type TtsProvider,
} from "./types";

interface PollyFormat extends AudioFormat {
  readonly native: OutputFormat;
}

/** Ogg Opus goes to Polly as ogg_vorbis; the shared id is the stored preference key, so only its label names the codec. */
const FORMATS: AudioFormats<PollyFormat> = [
  { ...FORMAT_MP3_64, native: OutputFormat.MP3 },
  { ...FORMAT_MP3, native: OutputFormat.MP3 },
  { ...FORMAT_OGG_OPUS, label: "Ogg Vorbis", native: OutputFormat.OGG_VORBIS },
];

/** Keyed by the engine names DescribeVoices reports, which are the stored model ids. */
const ENGINE_MAP: Record<string, Engine> = {
  standard: Engine.STANDARD,
  neural: Engine.NEURAL,
  generative: Engine.GENERATIVE,
  "long-form": Engine.LONG_FORM,
};

/** Exception names whose class the HTTP status alone would misread: credential failures arrive as 400/403, throttling as 400. */
const FAILURE_BY_EXCEPTION: Record<string, ErrorDescription> = {
  InvalidSignatureException: { kind: "key_rejected" },
  UnrecognizedClientException: { kind: "key_rejected" },
  InvalidClientTokenId: { kind: "key_rejected" },
  SignatureDoesNotMatch: { kind: "key_rejected" },
  // A valid key whose IAM policy lacks polly:SynthesizeSpeech passes DescribeVoices (Save & test); the
  // denial surfaces in the availability scan and the read.
  AccessDeniedException: { kind: "permission_denied" },
  ExpiredTokenException: { kind: "key_rejected" },
  ThrottlingException: { kind: "rate_limited" },
  TooManyRequestsException: { kind: "rate_limited" },
  ServiceFailureException: { kind: "provider_outage" },
  ServiceUnavailableException: { kind: "provider_outage" },
};

function sdkStatus(error: object): number | undefined {
  if (!("$metadata" in error) || typeof error.$metadata !== "object" || error.$metadata === null) {
    return undefined;
  }
  const metadata: object = error.$metadata;
  return "httpStatusCode" in metadata && typeof metadata.httpStatusCode === "number"
    ? metadata.httpStatusCode
    : undefined;
}

/** Engines that accept SSML prosody markup. Generative/long-form voices reject it. */
const SSML_ENGINES = new Set(["standard", "neural"]);

interface PollyProsody {
  speed: number;
  pitch: number;
  volumeGainDb: number;
}

/** Polly takes an ABSOLUTE rate percentage (100% = normal). Null means the request must go out as
 *  plain TEXT: no prosody needed, or the engine rejects SSML. */
export function buildSsml(text: string, model: string, prosody: PollyProsody): string | null {
  if (!SSML_ENGINES.has(model)) return null;

  const attributes: string[] = [];
  if (prosody.speed !== 1) {
    // Polly rejects rates above 200%; defense in depth on top of the clamp from ranges().
    const speed = Math.min(2, Math.max(0.2, prosody.speed));
    attributes.push(`rate="${Math.round(speed * 100)}%"`);
  }
  if (prosody.pitch !== 0 && model === "standard") {
    attributes.push(`pitch="${signedPercent(prosody.pitch)}"`);
  }
  if (prosody.volumeGainDb !== 0) {
    attributes.push(`volume="${signedDecibels(prosody.volumeGainDb)}"`);
  }

  if (attributes.length === 0) {
    return isSSML(text) ? text : null;
  }

  const inner = isSSML(text) ? unwrapSpeak(text) : escapeXml(text);
  return `<speak><prosody ${attributes.join(" ")}>${inner}</prosody></speak>`;
}

function createClient(credentials: Record<string, string>): PollyClient {
  return new PollyClient({
    region: credentials.region,
    // The SDK would otherwise make up to 3 attempts itself, ignoring the abort signal;
    // retryTransient in lib/messaging/retry.ts owns retries and honors it.
    maxAttempts: 1,
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
  outputFormat: OutputFormat,
): Promise<Uint8Array> {
  const ssml = buildSsml(text, args.model, args);
  // Plain-TEXT requests must not contain SSML markup (generative/long-form engines reject it).
  const plain = isSSML(text) ? stripSsmlTags(text) : text;

  const response = await client.send(
    new SynthesizeSpeechCommand({
      OutputFormat: outputFormat,
      Text: ssml ?? plain,
      TextType: (ssml ? TextType.SSML : TextType.TEXT) as TextType,
      VoiceId: args.voiceId as VoiceId,
      Engine: ENGINE_MAP[args.model.toLowerCase()] ?? Engine.STANDARD,
    }),
    { abortSignal: args.signal },
  );

  const bytes = await response.AudioStream?.transformToByteArray();
  // The SDK resolved, so the service answered 2xx; a missing or empty stream would play as
  // silence, so it is reported as an answer without audio.
  if (bytes === undefined || bytes.byteLength === 0) {
    const status = response.$metadata.httpStatusCode ?? 200;
    throw new ProviderHttpError("polly", "synthesis", status, NO_AUDIO_DETAIL);
  }
  return bytes;
}

export const polly: TtsProvider = {
  id: "polly",
  labelKey: "providers.polly.name",
  color: PROVIDER_COLORS.polly,

  credentialSchema: [
    {
      key: "accessKeyId",
      labelKey: "providers.polly.accessKeyId",
      placeholder: "AKIA...",
      type: "password",
      // Key ids are uppercase (AKIA/ASIA/...); catches the classic paste of the 40-char mixed-case
      // SECRET into this box before a doomed live test.
      hintPattern: /^A[A-Z0-9]{19,}$/,
      hintKey: "settings.hint_key_shape",
    },
    {
      key: "secretAccessKey",
      labelKey: "providers.polly.secretAccessKey",
      placeholder: "••••••••",
      type: "password",
    },
    {
      key: "region",
      role: "region",
      labelKey: "providers.polly.region",
      placeholder: "us-east-1",
      defaultValue: "us-east-1",
      type: "text",
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
    {
      value: "neural",
      labelKey: "models.neural",
      descriptionKey: "models.neural_description",
    },
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

  audioFormats: FORMATS,

  limits: { chunkBudget: () => characterBudget(3000), concurrency: 4 },

  async fetchVoices(credentials, signal) {
    const client = createClient(credentials);
    try {
      const voices: PollyVoice[] = [];
      let nextToken: string | undefined;
      do {
        const response = await client.send(new DescribeVoicesCommand({ NextToken: nextToken }), {
          abortSignal: signal,
        });
        voices.push(...(response.Voices ?? []));
        nextToken = response.NextToken;
      } while (nextToken);

      return voices.map((voice) =>
        NormalizedVoiceSchema.parse({
          id: voice.Id ?? "",
          providerId: "polly",
          displayName: voice.Id ?? "",
          languageCodes: [voice.LanguageCode ?? ""],
          gender: normalizeGender(voice.Gender),
          models: voice.SupportedEngines ?? ["standard"],
          sampleRate: 22050,
        } satisfies NormalizedVoiceDraft),
      );
    } finally {
      client.destroy();
    }
  },

  async synthesize(args): Promise<SynthResult> {
    const budget = this.limits.chunkBudget({ id: args.voiceId }, args.model);
    const chunks = chunkText(args.text, budget.limit, budget.sizeOf);
    const format = effectiveFormat(FORMATS, args.encoding, chunks.length);

    const client = createClient(args.credentials);
    try {
      const byteChunks = await mapWithConcurrency(
        chunks,
        this.limits.concurrency,
        (chunk) => synthesizeChunk(client, chunk, args, format.native),
        args.signal,
        this,
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
    // Polly caps the prosody rate at 200%; buildSsml clamps to it, so a slider allowing 3x would show
    // a speed the request cannot carry.
    return {
      ...DEFAULT_RANGES,
      speed: { min: 0.5, max: 2, default: 1, step: 0.05 },
    };
  },

  // The region is part of the endpoint hostname: a wrong one never answers.
  unreachableMessageKey: "errors.unreachable_region_message",
  describeError(error) {
    if (typeof error !== "object" || error === null) return undefined;
    const status = sdkStatus(error);
    if (status === undefined) return undefined;
    const name = "name" in error && typeof error.name === "string" ? error.name : "";
    return FAILURE_BY_EXCEPTION[name] ?? { kind: failureKindForStatus(status) };
  },
};
