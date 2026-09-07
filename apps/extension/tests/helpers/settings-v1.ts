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

// Corrupt v1 blobs: a valid blob with one or more fields replaced by a value
// no v1 writer ever stored there (a wrong primitive, null, "", NaN, an array,
// a record, an unknown provider id) or removed outright. Each field's corrupt
// space is disjoint from its valid one, so a default in the step's output can
// only be one the step made up.

type Kind = "null" | "emptyString" | "nan" | "boolean" | "number" | "string" | "array" | "record";

const KINDS: readonly (readonly [Kind, fc.Arbitrary<unknown>])[] = [
  ["null", fc.constant(null)],
  ["emptyString", fc.constant("")],
  ["nan", fc.constant(Number.NaN)],
  ["boolean", fc.boolean()],
  ["number", finite],
  ["string", fc.string({ minLength: 1 })],
  ["array", fc.array(fc.jsonValue(), { maxLength: 3 })],
  ["record", fc.dictionary(key, fc.jsonValue(), { maxKeys: 3 })],
];

/** Values of every kind except the ones the field legitimately holds. */
function wrongKind(...valid: Kind[]): fc.Arbitrary<unknown> {
  return fc.oneof(...KINDS.filter(([kind]) => !valid.includes(kind)).map(([, arb]) => arb));
}

/** A valid record with one entry overwritten by a corrupt value. */
function withCorruptEntry(
  valid: fc.Arbitrary<Record<string, unknown>>,
  entryKey: fc.Arbitrary<string>,
  corrupt: fc.Arbitrary<unknown>,
): fc.Arbitrary<Record<string, unknown>> {
  return fc
    .tuple(valid, entryKey, corrupt)
    .map(([record, k, value]) => ({ ...record, [k]: value }));
}

const unknownProviderId = key.filter((k) => !PROVIDER_IDS.some((id) => id === k));
const anyProviderKey = fc.oneof(providerId, unknownProviderId);
const isValidVoice = (voice: Record<string, unknown>) =>
  PROVIDER_IDS.some((id) => id === voice.providerId) &&
  typeof voice.voiceId === "string" &&
  voice.voiceId.length > 0;
const corruptVoiceRecord = fc
  .record(
    {
      providerId: fc.oneof(providerId, unknownProviderId, wrongKind("string")),
      voiceId: fc.oneof(fc.string({ minLength: 1 }), wrongKind("string")),
    },
    { requiredKeys: [] },
  )
  .filter((voice) => !isValidVoice(voice));
const corruptVoice = fc.oneof(wrongKind("record", "null"), corruptVoiceRecord);
const credentialRecord = fc.dictionary(key, fc.string());
const corruptCredentialRecord = fc.oneof(
  wrongKind("record"),
  withCorruptEntry(credentialRecord, key, wrongKind("string", "emptyString")),
);
const corruptFlags = fc.oneof(
  wrongKind("record"),
  withCorruptEntry(perProvider(fc.boolean()), anyProviderKey, wrongKind("boolean")),
);
const notOneOf = (values: readonly string[]) =>
  fc.oneof(
    wrongKind("string"),
    fc.string({ minLength: 1 }).filter((s) => !values.includes(s)),
  );

const CORRUPT_FIELDS = {
  credentials: fc.oneof(
    wrongKind("record"),
    withCorruptEntry(perProvider(credentialRecord), anyProviderKey, corruptCredentialRecord),
    withCorruptEntry(perProvider(credentialRecord), unknownProviderId, credentialRecord),
  ),
  credentialsValid: corruptFlags,
  enabledProviders: corruptFlags,
  selectedVoice: corruptVoice,
  voicesByLanguage: fc.oneof(
    wrongKind("record"),
    withCorruptEntry(fc.dictionary(key, selectedVoice), key, corruptVoice),
  ),
  favorites: fc.oneof(
    wrongKind("array"),
    fc
      .tuple(fc.array(fc.string()), wrongKind("string", "emptyString"))
      .map(([favorites, value]) => [...favorites, value]),
  ),
  model: wrongKind("string"),
  style: wrongKind("string", "emptyString"),
  speed: wrongKind("number"),
  pitch: wrongKind("number"),
  volumeGainDb: wrongKind("number"),
  readAloudEncoding: wrongKind("string", "emptyString"),
  downloadEncoding: wrongKind("string", "emptyString"),
  language: wrongKind("string", "emptyString"),
  theme: notOneOf(["light", "dark", "system"]),
  uiLanguage: notOneOf(["auto", ...EXTENSION_LOCALE_IDS]),
} satisfies Record<Exclude<keyof SettingsV1, "schemaVersion">, fc.Arbitrary<unknown>>;

const ABSENT = Symbol("absent");

const corruptPatch = fc
  .record(
    Object.fromEntries(
      Object.entries(CORRUPT_FIELDS).map(([field, arb]) => [
        field,
        fc.option(arb, { nil: ABSENT }),
      ]),
    ),
    { requiredKeys: [] },
  )
  .filter((patch) => Object.keys(patch).length > 0);

/** A valid v1 blob with at least one field corrupted or removed; the stamp
 *  stays 1 so the step always converts (a corrupt stamp is its own case). */
export const corruptSettingsV1: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(settingsV1, corruptPatch)
  .map(([valid, patch]) => {
    const merged: Record<string, unknown> = { ...valid, ...patch };
    return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== ABSENT));
  });
