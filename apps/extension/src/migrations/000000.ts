import type { ProviderId } from "@/providers/types";
import type { SettingsMigration } from "./index";

// ---------------------------------------------------------------------------
// Step 0: away from the unversioned flat keys the original forks
// (polly-for-chrome / azure-speech-for-chrome) wrote directly into
// chrome.storage.sync, to the schema v1 `settings` object. Chrome storage is
// extension-ID-scoped, so each listing only ever sees its own fork's data;
// property-presence detection is therefore correct per listing with no
// branching. The v1 shape is FROZEN here on purpose: later steps upgrade it
// further, and this file must keep producing the same output forever.
// ---------------------------------------------------------------------------

/** Every top-level key the forks ever wrote. Removed after the upgrade. */
export const FLAT_KEYS = [
  "language",
  "speed",
  "pitch",
  "voices",
  "readAloudEncoding",
  "downloadEncoding",
  "accessKeyId",
  "secretAccessKey",
  "subscriptionKey",
  "region",
  "audioProfile",
  "volumeGainDb",
  "credentialsValid",
  "apiKey",
  "apiKeyValid",
  "engine",
  "locale",
] as const;

/** AWS regions look like "us-east-1"; Azure regions are one word ("eastus"). */
export function looksLikeAwsRegion(region: string): boolean {
  return /^[a-z]{2}(-[a-z]+)+-\d+$/.test(region);
}

export interface FlatKeys {
  language?: string;
  speed?: number | string;
  pitch?: number | string;
  volumeGainDb?: number | string;
  voices?: Record<string, string>;
  readAloudEncoding?: string;
  downloadEncoding?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  subscriptionKey?: string;
  /** The oldest fork lineage stored a Google Cloud TTS API key here. */
  apiKey?: string;
  /** That same lineage stored its selected Google voice name here. */
  locale?: string;
  region?: string;
  credentialsValid?: boolean;
  engine?: string;
}

export interface SelectedVoiceV1 {
  providerId: ProviderId;
  voiceId: string;
}

/** Schema v1 as shipped in 2.0.0, frozen. */
export interface SettingsV1 {
  schemaVersion: 1;
  credentials: Partial<Record<ProviderId, Record<string, string>>>;
  credentialsValid: Partial<Record<ProviderId, boolean>>;
  enabledProviders: Partial<Record<ProviderId, boolean>>;
  selectedVoice: SelectedVoiceV1 | null;
  voicesByLanguage: Record<string, SelectedVoiceV1>;
  favorites: string[];
  model: string;
  style?: string;
  speed: number;
  pitch: number;
  volumeGainDb: number;
  readAloudEncoding: string;
  downloadEncoding: string;
  language: string;
  theme: "light" | "dark" | "system";
  uiLanguage: string;
}

const V1_DEFAULTS: SettingsV1 = {
  schemaVersion: 1,
  credentials: {},
  credentialsValid: {},
  enabledProviders: {},
  selectedVoice: null,
  voicesByLanguage: {},
  favorites: [],
  model: "neural",
  speed: 1,
  pitch: 0,
  volumeGainDb: 0,
  readAloudEncoding: "OGG_OPUS",
  downloadEncoding: "MP3_64_KBPS",
  language: "en-US",
  theme: "system",
  uiLanguage: "auto",
};

/** The forks sometimes persisted numbers as strings; never let that throw. */
function toNumber(value: number | string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** The v1 credential records, key by key with their defaults, as the
 *  providers' credential schemas stood at v1. Frozen with the rest of the
 *  shape: a later provider change must not rewrite history. */
const V1_CREDENTIAL_FIELDS = {
  polly: [
    ["accessKeyId", ""],
    ["secretAccessKey", ""],
    ["region", "us-east-1"],
  ],
  azure: [
    ["subscriptionKey", ""],
    ["region", "eastus"],
  ],
  google: [["apiKey", ""]],
} as const satisfies Partial<Record<ProviderId, readonly (readonly [string, string])[]>>;

/** `flatValues` maps each record key to the flat-key value that feeds it. */
function credentialRecord(
  providerId: keyof typeof V1_CREDENTIAL_FIELDS,
  flatValues: Record<string, string | undefined>,
): Record<string, string> {
  return Object.fromEntries(
    V1_CREDENTIAL_FIELDS[providerId].map(([key, fallback]) => [key, flatValues[key] || fallback]),
  );
}

export function hasFlatKeys(raw: Record<string, unknown>): boolean {
  return FLAT_KEYS.some((key) => raw[key] !== undefined);
}

/**
 * Build the v1 settings object from a flat-key snapshot. Providers are
 * detected by KEY PRESENCE (the forks wrote empty-string credential keys at
 * install time; truthiness would discard those users' voice choices and
 * settings entirely).
 */
export function settingsFromFlatKeys(flat: FlatKeys): SettingsV1 {
  const credentials: SettingsV1["credentials"] = {};
  const credentialsValid: SettingsV1["credentialsValid"] = {};
  const enabledProviders: SettingsV1["enabledProviders"] = {};

  const hasPolly = "accessKeyId" in flat || "secretAccessKey" in flat;
  const hasAzure = "subscriptionKey" in flat;
  const hasGoogle = "apiKey" in flat && Boolean(flat.apiKey);

  // The shared `region` field is ambiguous when both credential families
  // exist. Its format disambiguates (AWS regions are dashed).
  const region = flat.region ?? "";
  const regionForPolly = !hasAzure || looksLikeAwsRegion(region) ? region : "";
  const regionForAzure = !hasPolly || !looksLikeAwsRegion(region) ? region : "";

  if (hasPolly) {
    const complete = Boolean(flat.accessKeyId && flat.secretAccessKey);
    credentials.polly = credentialRecord("polly", {
      accessKeyId: flat.accessKeyId,
      secretAccessKey: flat.secretAccessKey,
      region: regionForPolly,
    });
    credentialsValid.polly = complete && flat.credentialsValid === true;
    enabledProviders.polly = complete;
  }
  if (hasAzure) {
    const complete = Boolean(flat.subscriptionKey);
    credentials.azure = credentialRecord("azure", {
      subscriptionKey: flat.subscriptionKey,
      region: regionForAzure,
    });
    credentialsValid.azure = complete && flat.credentialsValid === true;
    enabledProviders.azure = complete;
  }
  if (hasGoogle) {
    // Rescue the oldest lineage's Google Cloud TTS key instead of dropping it.
    credentials.google = credentialRecord("google", { apiKey: flat.apiKey });
    credentialsValid.google = false; // must be re-validated via Save & test
    enabledProviders.google = false;
  }

  // Voice ids can only belong to the fork that wrote them. Prefer the fork
  // whose credentials are COMPLETE; fall back to whichever family is present.
  const inferredProvider: ProviderId | null =
    flat.accessKeyId && flat.secretAccessKey
      ? "polly"
      : flat.subscriptionKey
        ? "azure"
        : hasPolly
          ? "polly"
          : hasAzure
            ? "azure"
            : null;

  const voicesByLanguage: Record<string, SelectedVoiceV1> = {};
  if (inferredProvider && flat.voices) {
    for (const [language, voiceId] of Object.entries(flat.voices)) {
      if (typeof voiceId === "string" && voiceId) {
        voicesByLanguage[language] = { providerId: inferredProvider, voiceId };
      }
    }
  }

  const language = flat.language ?? V1_DEFAULTS.language;
  let selectedVoice = voicesByLanguage[language] ?? Object.values(voicesByLanguage)[0] ?? null;

  // The Google-fork lineage kept its selected voice name in `locale`
  // (e.g. "en-US-Wavenet-A"); carry it over instead of dropping it.
  if (!selectedVoice && hasGoogle && typeof flat.locale === "string" && flat.locale) {
    selectedVoice = { providerId: "google", voiceId: flat.locale };
    const localeMatch = /^([a-z]{2,3}-[A-Z]{2})/.exec(flat.locale);
    const voiceLanguage = localeMatch?.[1] ?? language;
    voicesByLanguage[voiceLanguage] = selectedVoice;
  }

  // The Azure fork shipped a rollback from OGG downloads.
  const downloadEncoding =
    flat.downloadEncoding === "OGG_OPUS"
      ? V1_DEFAULTS.downloadEncoding
      : (flat.downloadEncoding ?? V1_DEFAULTS.downloadEncoding);

  return {
    ...V1_DEFAULTS,
    credentials,
    credentialsValid,
    enabledProviders,
    selectedVoice,
    voicesByLanguage,
    model: flat.engine ?? V1_DEFAULTS.model,
    speed: toNumber(flat.speed, V1_DEFAULTS.speed),
    pitch: toNumber(flat.pitch, V1_DEFAULTS.pitch),
    volumeGainDb: toNumber(flat.volumeGainDb, V1_DEFAULTS.volumeGainDb),
    readAloudEncoding: flat.readAloudEncoding ?? V1_DEFAULTS.readAloudEncoding,
    downloadEncoding,
    language,
  };
}

export const fromFlatKeys: SettingsMigration = {
  from: 0,
  description: "fork flat sync keys -> settings v1 object",
  up(raw) {
    if (!raw || typeof raw !== "object") return { ...V1_DEFAULTS };
    // Already a versioned blob: nothing left to convert.
    if ("schemaVersion" in raw) return raw;
    return settingsFromFlatKeys(raw as FlatKeys);
  },
};
