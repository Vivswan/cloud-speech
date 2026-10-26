import { PROVIDER_IDS, PROVIDER_NAMES, type ProviderId } from "@cloud-speech/constants";
import { z } from "zod";
import type { MessageKey } from "@/lib/text/i18n-runtime";
import { charSize, type SizeOf } from "@/lib/text/text";

// ---------------------------------------------------------------------------
// Everything provider-specific lives behind TtsProvider: a new provider is one
// file in this directory plus one line in index.ts. The id roster is shared
// with the website through @cloud-speech/constants.
// ---------------------------------------------------------------------------

export { PROVIDER_IDS, type ProviderId };

export interface CredentialField {
  /** Stored under settings.perProvider[providerId].credentials[key]. */
  key: string;

  /** Locale key of the label above the input. */
  labelKey: string;

  /** Shown in the empty input and quoted as `$1` by the field's warnings; a literal, the same in every locale. */
  placeholder: string;

  /** "password" masks the input and has invisible characters refused (lib/settings/credential-checks). */
  type: "text" | "password";

  /** May stay empty: a keyless local server has no API key. */
  optional?: boolean;

  /** Prefilled when nothing is stored yet, e.g. the most common region. */
  defaultValue?: string;

  /** Hard-validated before Save & test (lib/settings/credential-checks): "url" needs an absolute http(s) URL with a host. */
  format?: "url";

  /** Removed from a `url` field on save, with a visible note: users paste full endpoint URLs from server docs. */
  stripSuffixes?: string[];

  /** Warn-only, since key formats change: a non-empty trimmed value failing it shows hintKey under the field. */
  hintPattern?: RegExp;

  /** Locale key for the hintPattern warning; $1 = the field's placeholder. */
  hintKey?: string;

  /** Lets generic code find the region or endpoint field by meaning, never by key name. */
  role?: "region" | "endpoint";
}

interface ModelOption {
  /** Provider-native model/engine id (Polly/Azure "engine", OpenAI model). */
  value: string;

  /** Locale key of the name the picker shows for it. */
  labelKey: string;

  /** Locale key of a line telling the engine apart from its siblings. */
  descriptionKey?: string;
}

/** Non-empty by construction: model resolution relies on a first model. */
export type ModelOptions = readonly [ModelOption, ...ModelOption[]];

export function modelValues(models: ModelOptions): [string, ...string[]] {
  const [first, ...rest] = models;
  return [first.value, ...rest.map((model) => model.value)];
}

export interface AudioFormat {
  /** What the user's per-purpose choice is stored as, and SynthesizeArgs.encoding. */
  readonly id: string;

  /** The codec's own name, the same in every locale, like the UI language endonyms. */
  readonly label: string;

  /** Media type the synthesis result reports (SynthResult.mimeType). */
  readonly mimeType: string;

  /** The download's file extension, without the dot. */
  readonly extension: string;

  /** Safe to byte-concatenate independently encoded chunks. */
  readonly stitchable: boolean;

  /** Offered for downloads; resolveEncoding and effectiveFormat pick within one purpose. */
  readonly forDownload: boolean;

  /** Offered for read-aloud playback, the first such being the preview's and the default. */
  readonly forReadAloud: boolean;
}

/** Non-empty by construction: format resolution relies on a first format. */
export type AudioFormats<Format extends AudioFormat = AudioFormat> = readonly [Format, ...Format[]];

/** The one format every provider offers. */
export const FORMAT_MP3: AudioFormat = {
  id: "MP3",
  label: "MP3",
  mimeType: "audio/mpeg",
  extension: "mp3",
  stitchable: true,
  forDownload: true,
  forReadAloud: true,
};

/** Polly's and Azure's first format, so their default; its own id keeps a stored choice apart from MP3. */
export const FORMAT_MP3_64: AudioFormat = {
  id: "MP3_64_KBPS",
  label: "MP3 (64 kbps)",
  mimeType: "audio/mpeg",
  extension: "mp3",
  stitchable: true,
  forDownload: true,
  forReadAloud: true,
};

/** Concatenated Ogg chunks make a chained file Chrome plays badly, so never stitchable or forDownload. */
export const FORMAT_OGG_OPUS: AudioFormat = {
  id: "OGG_OPUS",
  label: "Ogg Opus",
  mimeType: "audio/ogg",
  extension: "ogg",
  stitchable: false,
  forDownload: false,
  forReadAloud: true,
};

/** Private: positiveInteger() below is the one way to make a ChunkBudget limit. */
const PositiveIntegerSchema = z.int().positive().brand<"PositiveInteger">();

/** A count the type itself keeps at one or more: a chunk budget of zero
 *  would send one request per character. */
export type PositiveInteger = z.infer<typeof PositiveIntegerSchema>;

/** Refuses anything else when the provider module loads, so an invalid limit
 *  never enters the registry. */
export function positiveInteger(value: number): PositiveInteger {
  return PositiveIntegerSchema.parse(value);
}

/** The most text one synthesis request may carry, in sizeOf's unit: characters, or UTF-8 bytes for an API that counts bytes. */
export interface ChunkBudget {
  limit: PositiveInteger;
  sizeOf: SizeOf;
}

export function characterBudget(limit: number): ChunkBudget {
  return { limit: positiveInteger(limit), sizeOf: charSize };
}

interface ProviderLimits {
  /** The one budget synthesize chunks by, asked with the voice and model the request carries;
   *  the Sandbox's split note reads the same answer, so a text it does not warn about is never
   *  billed as two requests. */
  chunkBudget(voice: VoiceTraits, model: string): ChunkBudget;

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

/** What ranges() answers before a provider narrows it, and what the sliders show with no voice chosen. */
export const DEFAULT_RANGES: ProsodyRanges = {
  speed: { min: 0.5, max: 3, default: 1, step: 0.05 },
  pitch: { min: -10, max: 10, default: 0, step: 0.1 },
  volumeGainDb: { min: -16, max: 16, default: 0, step: 1 },
};

/** Sentinel language code for voices that speak any language. */
export const MULTILINGUAL = "multilingual";

/** A selection whose voice is not in the cache supplies the id alone, so a predicate can still
 *  answer for it (Google tells Studio and Gemini voices apart by name). */
type VoiceTraits = Pick<NormalizedVoice, "id"> & Partial<Pick<NormalizedVoice, "styles">>;

/** A tuple with a rest element is the one Zod shape whose inferred type is
 *  the non-empty `[string, ...string[]]` (`.min(1)` still infers `string[]`). */
function nonEmptyStrings(item: z.ZodString) {
  return z.tuple([item], item);
}

/** Polly, Azure, and Google parse their voice lists through it, so an SDK or REST shape drift fails there, not deep in the UI. */
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

/** Polly says "Female", Google "MALE": the cache stores one casing so the picker can group on it.
 *  Azure keeps its own rule because it reports "Unknown" for some voices. */
export function normalizeGender(gender: string | undefined): string {
  if (!gender) return "Neutral";
  const lower = gender.toLowerCase();
  return lower.charAt(0).toUpperCase() + lower.slice(1);
}

export type NormalizedVoiceDraft = Omit<NormalizedVoice, "languageCodes" | "models"> & {
  languageCodes: string[];
  models: string[];
};

export interface SynthesizeArgs {
  /** Whole sanitized text (may be SSML); the provider owns chunking. */
  text: string;

  /** NormalizedVoice.id, never the composite providerId:voiceId key. */
  voiceId: string;

  /** The selected engine or model name; the custom provider sends a typed-in name through as is. */
  model: string;

  /** One of the voice's styles, as NormalizedVoice.styles lists them; Azure renders it as an mstts:express-as wrapper. */
  style?: string;

  /** BCP-47 code of the selected voice (from its languageCodes). */
  language?: string;

  /** The requested AudioFormat.id; effectiveFormat may still swap it when chunking. */
  encoding: string;

  /** Rate multiplier, 1 being the voice's own, already clamped to ranges(model).speed. */
  speed: number;

  /** Pitch offset, 0 being the voice's own; a percentage on SSML prosody, semitones on Google. */
  pitch: number;

  /** Gain in decibels, 0 being the voice's own level. */
  volumeGainDb: number;

  /** The stored values by CredentialField.key; an optional field's may be missing or empty. */
  credentials: Record<string, string>;

  /** Aborting cancels the in-flight requests and further chunks, and the provider rejects with an "AbortError". */
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
// lib/errors/errors.ts owns the class-to-sentence mapping.
// ---------------------------------------------------------------------------

export const FAILURE_KINDS = [
  /** 401 without a more specific story: the credentials do not work. */
  "key_rejected",
  /** 403 without a more specific story, or an IAM denial: the key is known but may not use speech. */
  "permission_denied",
  /** A region the provider refused before any request went out. */
  "region_rejected",
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
  /** Picks the stock sentence (lib/errors/errors.ts) unless messageKey, or for "unreachable" the provider's unreachableMessageKey, replaces it. */
  kind: FailureKind;

  /** Human name of the API or feature to switch on; `$2` in the message. */
  feature?: string;

  /** The one page where the user fixes it (a console link). */
  actionUrl?: string;

  /** Locale key of a sentence beating the kind's stock one; `$1` is the provider name, `$2` the feature. */
  messageKey?: MessageKey;
}

/** api_disabled's stock sentence names the feature to switch on, so the
 *  reading brings the feature or a sentence of its own. */
export type ErrorDescription =
  | (FailureReading & { kind: Exclude<FailureKind, "api_disabled"> })
  | (FailureReading & { kind: "api_disabled"; feature: string })
  | (FailureReading & { kind: "api_disabled"; messageKey: MessageKey });

export interface TtsProvider {
  /** The perProvider settings key and the first half of every voice key (lib/settings/voice-key.ts). */
  id: ProviderId;

  /** Locale key of the provider's name, as the UI and the error sentences show it. */
  labelKey: string;

  /** Brand accent used for badges/dots in the UI. */
  color: string;

  /** The Settings inputs in order; a provider is ready once every non-optional field holds a value. */
  credentialSchema: CredentialField[];

  /** The engines or models the picker lists; a voice's own NormalizedVoice.models may name others, as the custom provider's do. */
  models: ModelOptions;

  /** The encodings offered; the first per purpose is the default (lib/settings/provider-state.ts). */
  audioFormats: AudioFormats;

  /** Read by the provider's own synthesize path and by the Sandbox's split note. */
  limits: ProviderLimits;

  /** Save & test's probe, for a provider whose voice list succeeds with credentials that cannot
   *  synthesize. Throws the provider's own error on failure so the caller can classify it. Absent,
   *  fetchVoices is the probe (validateAndFetchVoices below). */
  validateAndFetchVoices?(
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

  // The capability predicates are voice/model-aware, never static booleans.
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

  /** The unreachable sentence when a wrong region or server URL is likelier; `$1` is the provider name. */
  unreachableMessageKey?: MessageKey;
}

/** Byte-concatenating a container format (Ogg/WebM) across chunks yields a chained file Chrome
 *  plays badly. Providers call this after chunking and report the returned mimeType/extension.
 *
 *    one chunk, or a stitchable format   -> the requested format, unchanged
 *    several chunks, non-stitchable      -> the first stitchable format serving the same purpose (forReadAloud/forDownload)
 *    no such alternative                 -> the requested format, the least-bad option */
export function effectiveFormat<Format extends AudioFormat>(
  formats: AudioFormats<Format>,
  requestedId: string,
  chunkCount: number,
): Format {
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

export type NonEmptyRoster = [NormalizedVoice, ...NormalizedVoice[]];

export class EmptyRosterError extends Error {
  override readonly name = "EmptyRosterError";

  constructor(readonly providerId: ProviderId) {
    super(`${PROVIDER_NAMES[providerId]} returned no voices`);
  }
}

/** The one reading of an empty voice list: a failed fetch. A provider returns
 *  what its API answered, and each consumer treats the throw like any other
 *  failure, so a 200 with no voices can never replace a cached roster
 *  (lib/settings/voices.ts) or pass Save & test. */
export function nonEmptyRoster(provider: TtsProvider, voices: NormalizedVoice[]): NonEmptyRoster {
  if (!hasVoice(voices)) throw new EmptyRosterError(provider.id);
  return voices;
}

function hasVoice(voices: NormalizedVoice[]): voices is NonEmptyRoster {
  return voices.length > 0;
}

export async function validateAndFetchVoices(
  provider: TtsProvider,
  credentials: Record<string, string>,
  signal?: AbortSignal,
): Promise<NonEmptyRoster> {
  const voices = await (provider.validateAndFetchVoices?.(credentials, signal) ??
    provider.fetchVoices(credentials, signal));
  return nonEmptyRoster(provider, voices);
}
