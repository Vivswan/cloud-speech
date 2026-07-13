import { browser } from "#imports";
import type { ProviderId } from "@/providers/types";
import {
  DEFAULT_SETTINGS,
  migrateExclusive,
  type SelectedVoice,
  type Settings,
  SettingsSchema,
} from "./storage";

// ---------------------------------------------------------------------------
// Legacy migration. The old forks (polly-for-chrome / azure-speech-for-chrome)
// stored settings as MANY top-level keys directly in chrome.storage.sync.
// Because Chrome storage is extension-ID-scoped, each published listing only
// ever sees its own fork's data; property-presence detection is therefore
// automatically correct per listing (polly/azure/cloud) with no branching.
// ---------------------------------------------------------------------------

/** Every top-level key the old forks ever wrote. Removed after migration. */
const LEGACY_KEYS = [
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

interface LegacySync {
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
  settings?: unknown;
}

/** Old forks sometimes persisted numbers as strings; never let that throw. */
function toNumber(value: number | string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Build the new Settings object from a legacy flat blob. Pure, unit-tested.
 * Providers are detected by KEY PRESENCE (the forks wrote empty-string
 * credential keys at install time; truthiness would discard those users'
 * voice choices and settings entirely).
 */
export function buildSettingsFromLegacy(legacy: LegacySync): Settings {
  const credentials: Settings["credentials"] = {};
  const credentialsValid: Settings["credentialsValid"] = {};
  const enabledProviders: Settings["enabledProviders"] = {};

  const hasPolly = "accessKeyId" in legacy || "secretAccessKey" in legacy;
  const hasAzure = "subscriptionKey" in legacy;
  const hasGoogle = "apiKey" in legacy && Boolean(legacy.apiKey);

  // The shared legacy `region` field is ambiguous when both credential
  // families exist. Its format disambiguates (AWS regions are dashed).
  const region = legacy.region ?? "";
  const regionForPolly = !hasAzure || looksLikeAwsRegion(region) ? region : "";
  const regionForAzure = !hasPolly || !looksLikeAwsRegion(region) ? region : "";

  if (hasPolly) {
    const complete = Boolean(legacy.accessKeyId && legacy.secretAccessKey);
    credentials.polly = {
      accessKeyId: legacy.accessKeyId ?? "",
      secretAccessKey: legacy.secretAccessKey ?? "",
      region: regionForPolly || "us-east-1",
    };
    credentialsValid.polly = complete && legacy.credentialsValid === true;
    enabledProviders.polly = complete;
  }
  if (hasAzure) {
    const complete = Boolean(legacy.subscriptionKey);
    credentials.azure = {
      subscriptionKey: legacy.subscriptionKey ?? "",
      region: regionForAzure || "eastus",
    };
    credentialsValid.azure = complete && legacy.credentialsValid === true;
    enabledProviders.azure = complete;
  }
  if (hasGoogle) {
    // Rescue the oldest lineage's Google Cloud TTS key instead of dropping it.
    credentials.google = { apiKey: legacy.apiKey ?? "" };
    credentialsValid.google = false; // must be re-validated via Save & test
    enabledProviders.google = false;
  }

  // Voice ids can only belong to the fork that wrote them. Prefer the fork
  // whose credentials are COMPLETE; fall back to whichever family is present.
  const inferredProvider: ProviderId | null =
    legacy.accessKeyId && legacy.secretAccessKey
      ? "polly"
      : legacy.subscriptionKey
        ? "azure"
        : hasPolly
          ? "polly"
          : hasAzure
            ? "azure"
            : null;

  const voicesByLanguage: Record<string, SelectedVoice> = {};
  if (inferredProvider && legacy.voices) {
    for (const [language, voiceId] of Object.entries(legacy.voices)) {
      if (typeof voiceId === "string" && voiceId) {
        voicesByLanguage[language] = { providerId: inferredProvider, voiceId };
      }
    }
  }

  const language = legacy.language ?? DEFAULT_SETTINGS.language;
  let selectedVoice = voicesByLanguage[language] ?? Object.values(voicesByLanguage)[0] ?? null;

  // The Google-fork lineage kept its selected voice name in `locale`
  // (e.g. "en-US-Wavenet-A"); carry it over instead of dropping it.
  if (!selectedVoice && hasGoogle && typeof legacy.locale === "string" && legacy.locale) {
    selectedVoice = { providerId: "google", voiceId: legacy.locale };
    const localeMatch = /^([a-z]{2,3}-[A-Z]{2})/.exec(legacy.locale);
    const voiceLanguage = localeMatch?.[1] ?? language;
    voicesByLanguage[voiceLanguage] = selectedVoice;
  }

  // The Azure fork shipped a rollback from OGG downloads (stitching bug).
  const downloadEncoding =
    legacy.downloadEncoding === "OGG_OPUS"
      ? "MP3_64_KBPS"
      : (legacy.downloadEncoding ?? DEFAULT_SETTINGS.downloadEncoding);

  return SettingsSchema.parse({
    credentials,
    credentialsValid,
    enabledProviders,
    selectedVoice,
    voicesByLanguage,
    model: legacy.engine ?? DEFAULT_SETTINGS.model,
    speed: toNumber(legacy.speed, DEFAULT_SETTINGS.speed),
    pitch: toNumber(legacy.pitch, DEFAULT_SETTINGS.pitch),
    volumeGainDb: toNumber(legacy.volumeGainDb, DEFAULT_SETTINGS.volumeGainDb),
    readAloudEncoding: legacy.readAloudEncoding ?? DEFAULT_SETTINGS.readAloudEncoding,
    downloadEncoding,
    language,
  });
}

/**
 * Migrate legacy flat keys → the single `settings` object. Idempotent and
 * non-destructive: writes the new object FIRST, then removes only the known
 * legacy keys (never `storage.sync.clear()`). Any error leaves the legacy
 * data untouched; startup must never be aborted by a migration failure.
 */
export async function migrateLegacySettings(): Promise<boolean> {
  try {
    // The whole sequence runs inside the settings write lock: the snapshot,
    // the idempotency check, and the write are atomic against popup writes.
    return await migrateExclusive(async (write) => {
      const raw = (await browser.storage.sync.get(null)) as LegacySync;

      // Already migrated (or fresh install with nothing to migrate).
      if (raw.settings !== undefined) return false;

      const hasLegacyData = LEGACY_KEYS.some((key) => raw[key as keyof LegacySync] !== undefined);
      if (!hasLegacyData) return false;

      const settings = buildSettingsFromLegacy(raw);
      await write(settings);
      await browser.storage.sync.remove([...LEGACY_KEYS]);
      console.log("Migrated legacy settings");
      return true;
    });
  } catch (error) {
    console.error("Legacy settings migration failed; keeping legacy data intact", error);
    return false;
  }
}
