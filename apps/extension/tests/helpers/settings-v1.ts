import { EXTENSION_LOCALE_IDS } from "@cloud-speech/constants";
import fc from "fast-check";
import type { SettingsV1 } from "@/migrations/000000";
import { PROVIDER_IDS } from "@/providers/types";

// Arbitrary v1 blobs, mirroring the FROZEN SettingsV1 shape (never the live
// schema: after a version bump the live schema would reject every v1
// candidate and a property over it would run on nothing).

/** Every SettingsV1 key except the optional `style`. */
export const V1_REQUIRED_KEYS = [
  "schemaVersion",
  "credentials",
  "credentialsValid",
  "enabledProviders",
  "selectedVoice",
  "voicesByLanguage",
  "favorites",
  "model",
  "speed",
  "pitch",
  "volumeGainDb",
  "readAloudEncoding",
  "downloadEncoding",
  "language",
  "theme",
  "uiLanguage",
] as const satisfies readonly (keyof SettingsV1)[];

const providerId = fc.constantFrom(...PROVIDER_IDS);
const key = fc.string({ minLength: 1, maxLength: 12 }).filter((k) => k !== "__proto__");
const perProvider = <T>(value: fc.Arbitrary<T>) =>
  fc.dictionary(providerId, value, { maxKeys: PROVIDER_IDS.length });
const selectedVoice = fc.record({ providerId, voiceId: fc.string({ minLength: 1 }) });
const finite = fc.double({ noNaN: true, noDefaultInfinity: true });

export const settingsV1: fc.Arbitrary<SettingsV1> = fc.record(
  {
    schemaVersion: fc.constant(1 as const),
    credentials: perProvider(fc.dictionary(key, fc.string())),
    credentialsValid: perProvider(fc.boolean()),
    enabledProviders: perProvider(fc.boolean()),
    selectedVoice: fc.option(selectedVoice, { nil: null }),
    voicesByLanguage: fc.dictionary(key, selectedVoice),
    favorites: fc.array(fc.string()),
    // The picker only ever stored one of the voice's engines, never "".
    model: fc.string({ minLength: 1 }),
    style: fc.string(),
    speed: finite,
    pitch: finite,
    volumeGainDb: finite,
    readAloudEncoding: fc.string(),
    downloadEncoding: fc.string(),
    language: fc.string(),
    theme: fc.constantFrom("light", "dark", "system"),
    uiLanguage: fc.constantFrom("auto", ...EXTENSION_LOCALE_IDS),
  },
  { requiredKeys: [...V1_REQUIRED_KEYS] },
);
