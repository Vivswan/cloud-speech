import type { ProviderId } from "@/providers/types";
import type { SettingsMigration } from "./ladder";

// ---------------------------------------------------------------------------
// The forks' unversioned flat chrome.storage.sync keys -> the schema v1
// object, frozen here so this file keeps producing the same output forever.
// Chrome storage is extension-id-scoped, so each listing only sees its own
// fork's data and key presence identifies the fork.
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

/** As the forks wrote them; `locale` is the Google lineage's selected voice name, not a locale. */
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
  apiKey?: string;
  locale?: string;
  region?: string;
  credentialsValid?: boolean;
  engine?: string;
}

interface SelectedVoiceV1 {
  providerId: ProviderId;
  voiceId: string;
}

/** The forks whose keys the listing carries. */
interface PresentForks {
  polly: boolean;
  azure: boolean;
  google: boolean;
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

type V1Providers = Pick<SettingsV1, "credentials" | "credentialsValid" | "enabledProviders">;

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

/** The providers' credential schemas as they stood at v1, frozen: a later provider change must not rewrite history. */
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

/** The Polly and Azure forks wrote empty-string credential keys at install time, so truthiness
 *  would discard those users' voice choices and settings.
 *
 *    accessKeyId / secretAccessKey / subscriptionKey  -> detected by key presence
 *    apiKey (Google)                                  -> detected by a non-empty value */
function presentForks(flat: FlatKeys): PresentForks {
  return {
    polly: "accessKeyId" in flat || "secretAccessKey" in flat,
    azure: "subscriptionKey" in flat,
    google: "apiKey" in flat && Boolean(flat.apiKey),
  };
}

/** Google arrives neither enabled nor valid: its key must be re-validated via Save & test. */
function providersFromFlatKeys(flat: FlatKeys, forks: PresentForks): V1Providers {
  const credentials: SettingsV1["credentials"] = {};
  const credentialsValid: SettingsV1["credentialsValid"] = {};
  const enabledProviders: SettingsV1["enabledProviders"] = {};

  // The shared `region` field is ambiguous when both credential families exist; AWS regions are dashed.
  const region = flat.region ?? "";
  const regionForPolly = !forks.azure || looksLikeAwsRegion(region) ? region : "";
  const regionForAzure = !forks.polly || !looksLikeAwsRegion(region) ? region : "";

  if (forks.polly) {
    const complete = Boolean(flat.accessKeyId && flat.secretAccessKey);
    credentials.polly = credentialRecord("polly", {
      accessKeyId: flat.accessKeyId,
      secretAccessKey: flat.secretAccessKey,
      region: regionForPolly,
    });
    credentialsValid.polly = complete && flat.credentialsValid === true;
    enabledProviders.polly = complete;
  }

  if (forks.azure) {
    const complete = Boolean(flat.subscriptionKey);
    credentials.azure = credentialRecord("azure", {
      subscriptionKey: flat.subscriptionKey,
      region: regionForAzure,
    });
    credentialsValid.azure = complete && flat.credentialsValid === true;
    enabledProviders.azure = complete;
  }

  if (forks.google) {
    credentials.google = credentialRecord("google", { apiKey: flat.apiKey });
    credentialsValid.google = false;
    enabledProviders.google = false;
  }

  return { credentials, credentialsValid, enabledProviders };
}

/** Voice ids can only belong to the fork that wrote them. The fork whose credentials are complete
 *  wins; else whichever family is present. */
function voiceProvider(flat: FlatKeys, forks: PresentForks): ProviderId | null {
  if (flat.accessKeyId && flat.secretAccessKey) return "polly";
  if (flat.subscriptionKey) return "azure";
  if (forks.polly) return "polly";
  if (forks.azure) return "azure";
  return null;
}

function voicesFromFlatKeys(
  flat: FlatKeys,
  provider: ProviderId | null,
): Record<string, SelectedVoiceV1> {
  const voicesByLanguage: Record<string, SelectedVoiceV1> = {};
  if (!provider || !flat.voices) return voicesByLanguage;

  for (const [language, voiceId] of Object.entries(flat.voices)) {
    if (typeof voiceId !== "string" || !voiceId) continue;
    voicesByLanguage[language] = { providerId: provider, voiceId };
  }

  return voicesByLanguage;
}

/** Every field a fork never wrote takes its v1 default, so any listing yields a complete v1 object. */
export function settingsFromFlatKeys(flat: FlatKeys): SettingsV1 {
  const forks = presentForks(flat);
  const { credentials, credentialsValid, enabledProviders } = providersFromFlatKeys(flat, forks);
  const voicesByLanguage = voicesFromFlatKeys(flat, voiceProvider(flat, forks));

  const language = flat.language ?? V1_DEFAULTS.language;
  let selectedVoice = voicesByLanguage[language] ?? Object.values(voicesByLanguage)[0] ?? null;

  // The Google-fork lineage kept its selected voice name in `locale` (e.g. "en-US-Wavenet-A").
  if (!selectedVoice && forks.google && typeof flat.locale === "string" && flat.locale) {
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

export const flatKeysToSettingsObject: SettingsMigration = {
  description: "fork flat sync keys -> settings v1 object",
  up(raw) {
    if (!raw || typeof raw !== "object") return { ...V1_DEFAULTS };
    if ("schemaVersion" in raw) return raw;
    return settingsFromFlatKeys(raw as FlatKeys);
  },
};
