import { PROVIDER_IDS, type ProviderId } from "@cloud-speech/constants";
import { z } from "zod";
import type { MessageKey } from "@/lib/i18n-runtime";

// ---------------------------------------------------------------------------
// Everything provider-specific lives behind TtsProvider: a new provider is one
// file in this directory plus one line in index.ts. The id roster is shared
// with the website through @cloud-speech/constants.
// ---------------------------------------------------------------------------

export { PROVIDER_IDS, type ProviderId };

export interface CredentialField {
  /** Stored under settings.perProvider[providerId].credentials[key]. */
  key: string;
  labelKey: string;
  placeholder: string;
  type: "text" | "password";
  /** May stay empty: a keyless local server has no API key. */
  optional?: boolean;
  /** Prefilled when nothing is stored yet, e.g. the most common region. */
  defaultValue?: string;
  /** Hard-validated before Save & test (lib/credential-checks): "url" needs an absolute http(s) URL with a host. */
  format?: "url";
  /** Removed from a `url` field on save, with a visible note: users paste full endpoint URLs from server docs. */
  stripSuffixes?: string[];
  /** Warn-only: a non-empty trimmed value failing it shows hintKey under the field (lib/credential-checks).
   *  Never blocks Save & test, since key formats change. */
  hintPattern?: RegExp;
  /** Locale key for the hintPattern warning; $1 = the field's placeholder. */
  hintKey?: string;
}

export interface ModelOption {
  /** Provider-native model/engine id (Polly/Azure "engine", OpenAI model). */
  value: string;
  labelKey: string;
  descriptionKey?: string;
}

/** Non-empty by construction: model resolution relies on a first model. */
export type ModelOptions = readonly [ModelOption, ...ModelOption[]];

export function modelValues(models: ModelOptions): [string, ...string[]] {
  const [first, ...rest] = models;
  return [first.value, ...rest.map((model) => model.value)];
}

export interface AudioFormat {
  readonly id: string;
  readonly mimeType: string;
  readonly extension: string;
  /** Safe to byte-concatenate independently encoded chunks. */
  readonly stitchable: boolean;
  readonly forDownload: boolean;
  readonly forReadAloud: boolean;
}

/** Non-empty by construction: format resolution relies on a first format. */
export type AudioFormats = readonly [AudioFormat, ...AudioFormat[]];

export const FORMAT_MP3: AudioFormat = {
  id: "MP3",
  mimeType: "audio/mpeg",
  extension: "mp3",
  stitchable: true,
  forDownload: true,
  forReadAloud: true,
};

export const FORMAT_MP3_64: AudioFormat = {
  id: "MP3_64_KBPS",
  mimeType: "audio/mpeg",
  extension: "mp3",
  stitchable: true,
  forDownload: true,
  forReadAloud: true,
};

/** Ogg is a container: byte-concatenating independently encoded chunks yields a chained file
 *  Chrome plays badly, so OGG_OPUS must never claim stitchable or forDownload. */
export const FORMAT_OGG_OPUS: AudioFormat = {
  id: "OGG_OPUS",
  mimeType: "audio/ogg",
  extension: "ogg",
  stitchable: false,
  forDownload: false,
  forReadAloud: true,
};

export interface ProviderLimits {
  /** Max characters per synthesis request; provider chunks above this. */
  maxChars: number;
  concurrency: number;
}

export interface ProsodyRange {
  min: number;
  max: number;
  default: number;
  step: number;
}

export interface ProsodyRanges {
  speed: ProsodyRange;
  pitch: ProsodyRange;
  volumeGainDb: ProsodyRange;
}

export const DEFAULT_RANGES: ProsodyRanges = {
  speed: { min: 0.5, max: 3, default: 1, step: 0.05 },
  pitch: { min: -10, max: 10, default: 0, step: 0.1 },
  volumeGainDb: { min: -16, max: 16, default: 0, step: 1 },
};

// ---------------------------------------------------------------------------
// Normalized voice, validated with Zod before entering the session cache so
// SDK/REST shape drift fails loudly at the boundary, not deep in the UI.
// ---------------------------------------------------------------------------

/** Sentinel language code for voices that speak any language. */
export const MULTILINGUAL = "multilingual";

/** A selection whose voice is not in the cache supplies the id alone, so a predicate can still
 *  answer for it (Google tells Studio and Gemini voices apart by name). */
export type VoiceTraits = Pick<NormalizedVoice, "id"> & Partial<Pick<NormalizedVoice, "styles">>;

/** A tuple with a rest element is the one Zod shape whose inferred type is
 *  the non-empty `[string, ...string[]]` (`.min(1)` still infers `string[]`). */
function nonEmptyStrings(item: z.ZodString) {
  return z.tuple([item], item);
}

export const NormalizedVoiceSchema = z.object({
  /** Provider-native synthesis id (Polly `Id`, Azure `shortName`). */
  id: z.string().min(1),
  providerId: z.enum(PROVIDER_IDS),
  displayName: z.string().min(1),
  languageCodes: nonEmptyStrings(z.string().min(2)),
  gender: z.string(),
  models: nonEmptyStrings(z.string().min(1)),
  styles: z.array(z.string()).optional(),
  sampleRate: z.number().optional(),
});

export type NormalizedVoice = z.infer<typeof NormalizedVoiceSchema>;

export type NormalizedVoiceDraft = Omit<NormalizedVoice, "languageCodes" | "models"> & {
  languageCodes: string[];
  models: string[];
};

export interface SynthesizeArgs {
  /** Whole sanitized text (may be SSML); the provider owns chunking. */
  text: string;
  voiceId: string;
  model: string;
  style?: string;
  /** BCP-47 code of the selected voice (from its languageCodes). */
  language?: string;
  /** AudioFormat.id */
  encoding: string;
  speed: number;
  pitch: number;
  volumeGainDb: number;
  credentials: Record<string, string>;
  /** Aborting it cancels every in-flight request of this synthesis and stops
   *  further chunks; the provider rejects with an "AbortError". */
  signal: AbortSignal;
}

export interface SynthResult {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
}

// ---------------------------------------------------------------------------
// The user sees a failure by its class, never by its provider: one "key
// rejected" sentence for every provider, with its name filled in.
// lib/errors.ts owns the class-to-sentence mapping.
// ---------------------------------------------------------------------------

export const FAILURE_KINDS = [
  /** 401/403 without a more specific story: the credentials do not work. */
  "key_rejected",
  /** The account exists but the API or feature the voice needs is off. */
  "api_disabled",
  /** The account has no credit or quota left; retrying will not help. */
  "quota_exhausted",
  /** 429: the provider throttled the request. */
  "rate_limited",
  /** 5xx: the provider's own trouble. */
  "provider_outage",
  /** 4xx: the provider will not read this text with this voice. */
  "request_refused",
  /** No answer at all: DNS, offline, a server that is down. */
  "unreachable",
  "unknown",
] as const;

export type FailureKind = (typeof FAILURE_KINDS)[number];

interface FailureReading {
  kind: FailureKind;
  /** Human name of the API or feature to switch on; `$2` in the message. */
  feature?: string;
  /** The one page where the user fixes it (a console link). */
  actionUrl?: string;
  /** Locale key of a sentence more useful than the kind's stock one; `$1` is
   *  the provider name, `$2` the feature. */
  messageKey?: MessageKey;
}

/** api_disabled's stock sentence names the feature to switch on, so the
 *  reading brings the feature or a sentence of its own. */
export type ErrorDescription =
  | (FailureReading & { kind: Exclude<FailureKind, "api_disabled"> })
  | (FailureReading & { kind: "api_disabled"; feature: string })
  | (FailureReading & { kind: "api_disabled"; messageKey: MessageKey });

export interface TtsProvider {
  id: ProviderId;
  labelKey: string;
  /** Brand accent used for badges/dots in the UI. */
  color: string;
  credentialSchema: CredentialField[];
  models: ModelOptions;
  audioFormats: AudioFormats;
  limits: ProviderLimits;

  hasCredentials(credentials?: Record<string, string>): boolean;
  /** Throws the provider's own error on failure so the caller can classify it. */
  validateAndFetchVoices(
    credentials: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<NormalizedVoice[]>;
  /** Throws on failure; the caller isolates per-provider errors. */
  fetchVoices(
    credentials: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<NormalizedVoice[]>;
  /** Owns whole-text chunking + format-aware assembly. */
  synthesize(args: SynthesizeArgs): Promise<SynthResult>;

  // Capability predicates: voice/model-aware, never static booleans.
  supportsSpeed(voice: VoiceTraits | undefined, model: string): boolean;
  supportsPitch(voice: VoiceTraits | undefined, model: string): boolean;
  supportsVolume(voice: VoiceTraits | undefined, model: string): boolean;
  supportsStyle(voice: VoiceTraits | undefined, model: string): boolean;
  supportsSSML(voice: VoiceTraits | undefined, model: string): boolean;
  ranges(model: string): ProsodyRanges;

  /** Recognize an error by this provider's own marks (error bodies, SDK exception names). Undefined
   *  leaves the status-based reading to the caller and is the only right answer for an error bearing
   *  no mark: an unattributed error is offered to every provider in turn. */
  describeError?(error: unknown): ErrorDescription | undefined;
  /** Sentence for a request that never got an answer, when the provider's own configuration
   *  (a region, a server URL) is a likelier cause than the internet; `$1` is the provider name. */
  unreachableMessageKey?: MessageKey;
}

/** Byte-concatenating a container format (Ogg/WebM) across chunks yields a chained file Chrome
 *  plays badly. Providers call this after chunking and report the returned mimeType/extension.
 *
 *    one chunk, or a stitchable format   -> the requested format, unchanged
 *    several chunks, non-stitchable      -> the first stitchable format serving the same purpose (forReadAloud/forDownload)
 *    no such alternative                 -> the requested format, the least-bad option */
export function effectiveFormat(
  formats: AudioFormats,
  requestedId: string,
  chunkCount: number,
): AudioFormat {
  const requested = formats.find((f) => f.id === requestedId) ?? formats[0];
  if (chunkCount <= 1 || requested.stitchable) return requested;

  const alternative = formats.find(
    (f) =>
      f.stitchable &&
      (!requested.forReadAloud || f.forReadAloud) &&
      (!requested.forDownload || f.forDownload),
  );
  return alternative ?? requested;
}

export function hasAllCredentialFields(
  schema: CredentialField[],
  credentials?: Record<string, string>,
): boolean {
  if (!credentials) return false;
  return schema.every((field) => field.optional || Boolean(credentials[field.key]?.trim()));
}
