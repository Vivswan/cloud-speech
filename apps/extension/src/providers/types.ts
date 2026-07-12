import { z } from "zod";

// ---------------------------------------------------------------------------
// Provider abstraction. Everything provider-specific lives behind TtsProvider
// so adding a new API = one new file in this directory + one registry line.
// ---------------------------------------------------------------------------

export type ProviderId = "polly" | "azure" | "google" | "openai" | "custom";

export const PROVIDER_IDS = [
  "polly",
  "azure",
  "google",
  "openai",
  "custom",
] as const satisfies readonly ProviderId[];

export interface CredentialField {
  /** Stored under settings.credentials[providerId][key]. */
  key: string;
  labelKey: string;
  placeholder: string;
  type: "text" | "password";
  /** Not required for the provider to count as configured (e.g. an API key
   *  that keyless local servers don't need). */
  optional?: boolean;
  /** "Where do I get this?" deep link. */
  helpUrl?: string;
}

export interface ModelOption {
  /** Provider-native model/engine id (Polly/Azure "engine", OpenAI model). */
  value: string;
  labelKey: string;
  descriptionKey?: string;
}

export interface AudioFormat {
  /** Canonical encoding id used across the app (e.g. "MP3_64_KBPS"). */
  id: string;
  mimeType: string;
  extension: string;
  /** Safe to byte-concatenate independently encoded chunks. */
  stitchable: boolean;
  forDownload: boolean;
  forReadAloud: boolean;
}

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
// Normalized voice — validated with Zod before entering the session cache so
// SDK/REST shape drift fails loudly at the boundary, not deep in the UI.
// ---------------------------------------------------------------------------

export const NormalizedVoiceSchema = z.object({
  /** Provider-native synthesis id (Polly `Id`, Azure `shortName`). */
  id: z.string().min(1),
  providerId: z.enum(PROVIDER_IDS),
  displayName: z.string().min(1),
  languageCodes: z.array(z.string().min(2)).min(1),
  gender: z.string(),
  /** Model/engine ids this voice supports. */
  models: z.array(z.string().min(1)).min(1),
  styles: z.array(z.string()).optional(),
  sampleRate: z.number().optional(),
});

export type NormalizedVoice = z.infer<typeof NormalizedVoiceSchema>;

export interface SynthesizeArgs {
  /** Whole sanitized text (may be SSML) — the provider owns chunking. */
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
}

export interface SynthResult {
  bytes: Uint8Array;
  mimeType: string;
  extension: string;
}

export interface TtsProvider {
  id: ProviderId;
  labelKey: string;
  /** Brand accent used for badges/dots in the UI. */
  color: string;
  credentialSchema: CredentialField[];
  models: ModelOption[];
  audioFormats: AudioFormat[];
  limits: ProviderLimits;

  hasCredentials(credentials?: Record<string, string>): boolean;
  validateCredentials(credentials: Record<string, string>): Promise<boolean>;
  /** Throws on failure — the caller isolates per-provider errors. */
  fetchVoices(credentials: Record<string, string>): Promise<NormalizedVoice[]>;
  /** Owns whole-text chunking + format-aware assembly. */
  synthesize(args: SynthesizeArgs): Promise<SynthResult>;

  // Capability predicates — voice/model-aware, never static booleans.
  supportsSpeed(voice: NormalizedVoice | undefined, model: string): boolean;
  supportsPitch(voice: NormalizedVoice | undefined, model: string): boolean;
  supportsVolume(voice: NormalizedVoice | undefined, model: string): boolean;
  supportsStyle(voice: NormalizedVoice | undefined, model: string): boolean;
  supportsSSML(voice: NormalizedVoice | undefined, model: string): boolean;
  ranges(model: string): ProsodyRanges;
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
  formats: AudioFormat[],
  requestedId: string,
  chunkCount: number,
): AudioFormat | undefined {
  const requested = formats.find((f) => f.id === requestedId) ?? formats[0];
  if (!requested) return undefined;
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
