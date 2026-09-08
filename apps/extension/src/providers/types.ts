import { PROVIDER_IDS, type ProviderId } from "@cloud-speech/constants";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Provider abstraction. Everything provider-specific lives behind TtsProvider
// so adding a new API = one new file in this directory + one registry line.
// The provider ID roster itself is shared with the website via
// @cloud-speech/constants.
// ---------------------------------------------------------------------------

export { PROVIDER_IDS, type ProviderId };

export interface CredentialField {
  /** Stored under settings.perProvider[providerId].credentials[key]. */
  key: string;
  labelKey: string;
  placeholder: string;
  type: "text" | "password";
  /** Not required for the provider to count as configured (e.g. an API key
   *  that keyless local servers don't need). */
  optional?: boolean;
  /** Prefilled into the input when nothing is stored yet (e.g. the most
   *  common cloud region); the user can overwrite it freely. */
  defaultValue?: string;
  /** Value shape the generic Settings UI hard-validates before Save & test.
   *  "url" requires an absolute http(s) URL with a host. */
  format?: "url";
  /** Endpoint suffixes auto-removed from a `url` field on save (with a
   *  visible note): users paste full endpoint URLs from server docs. */
  stripSuffixes?: string[];
  /** Warn-only shape check: a non-empty trimmed value failing this pattern
   *  shows the hintKey message under the field. NEVER blocks Save & test;
   *  the live validation stays the authority (key formats change). */
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

/** The model ids of a roster, keeping its non-empty guarantee. */
export function modelValues(models: ModelOptions): [string, ...string[]] {
  const [first, ...rest] = models;
  return [first.value, ...rest.map((model) => model.value)];
}

export interface AudioFormat {
  /** Canonical encoding id used across the app (e.g. "MP3_64_KBPS"). */
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

/** Ogg is a container: byte-concatenating independently encoded chunks yields
 *  a chained file Chrome plays badly, so OGG_OPUS must never claim
 *  stitchable or forDownload (a fork shipped that once and rolled it back). */
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
  /** Max parallel synthesis requests. */
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

/** What a capability predicate may ask of a voice: its id (Google tells its
 *  Studio and Gemini voices apart by name) and its styles. A selection whose
 *  voice is not in the cache supplies the id alone, so a predicate can still
 *  answer for it. */
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
  /** Model/engine ids this voice supports. */
  models: nonEmptyStrings(z.string().min(1)),
  styles: z.array(z.string()).optional(),
  sampleRate: z.number().optional(),
});

export type NormalizedVoice = z.infer<typeof NormalizedVoiceSchema>;

/** What a provider hands to NormalizedVoiceSchema.parse: the plain arrays an
 *  SDK/REST response yields, which the parse promotes to non-empty tuples. */
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
// Failure vocabulary. The user sees a failure by its class, never by its
// provider: the same "key rejected" sentence for every provider, with the
// provider's name filled in. A provider recognizes its own error bodies
// (Google's SERVICE_DISABLED, Polly's SDK exception names) through
// describeError; lib/errors.ts owns the class-to-sentence mapping.
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

/** What a provider knows about one of its failures. */
export interface ErrorDescription {
  kind: FailureKind;
  /** Human name of the API or feature to switch on (api_disabled); `$2` in
   *  the message. */
  feature?: string;
  /** The one page where the user fixes it (a console link). */
  actionUrl?: string;
  /** Locale key of a sentence more useful than the kind's stock one; `$1` is
   *  the provider name, `$2` the feature. */
  messageKey?: string;
}

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
  /** Validate credentials and return the fresh voices proven by that check.
   *  Throws a provider error on failure so the caller can classify it. */
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

  /** Recognize an error by this provider's own marks: its error bodies, its
   *  SDK's exception names. Undefined leaves the generic status-based reading
   *  to the caller, and is the only right answer for an error bearing no such
   *  mark (a bare network failure): an unattributed error is offered to every
   *  provider in turn. */
  describeError?(error: unknown): ErrorDescription | undefined;
  /** Locale key of the sentence for a request that never got an answer, when
   *  the provider's own configuration (a region, a server URL) is a likelier
   *  cause than the internet; `$1` is the provider name. */
  unreachableMessageKey?: string;
}

/**
 * Resolve the format ACTUALLY safe to use for a synthesis that produced
 * `chunkCount` independently encoded chunks. Byte-concatenating container
 * formats (Ogg/WebM) yields a chained file Chrome plays badly, so when the
 * requested format is not stitchable and there is more than one chunk, fall
 * back to the first stitchable format serving the same purpose
 * (forReadAloud/forDownload). Providers call this AFTER chunking and must
 * report the returned mimeType/extension.
 */
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
  // No stitchable alternative: the requested format is the least-bad option.
  return alternative ?? requested;
}

/** Every REQUIRED credentialSchema field must be non-empty to count. */
export function hasAllCredentialFields(
  schema: CredentialField[],
  credentials?: Record<string, string>,
): boolean {
  if (!credentials) return false;
  return schema.every((field) => field.optional || Boolean(credentials[field.key]?.trim()));
}
