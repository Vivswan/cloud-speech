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
// toStrictEqual compares the two values' `constructor`, own property included,
// so a record whose own "constructor" holds NaN cannot equal even itself.
const key = fc
  .string({ minLength: 1, maxLength: 12 })
  .filter((k) => k !== "__proto__" && k !== "constructor");
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
  // A map that is not a record is one case; a map with a corrupt entry or an
  // unknown provider is a family, and the only shape the step makes entries from.
  credentials: fc.oneof(
    { arbitrary: wrongKind("record"), weight: 1 },
    {
      arbitrary: withCorruptEntry(
        perProvider(credentialRecord),
        anyProviderKey,
        corruptCredentialRecord,
      ),
      weight: 2,
    },
    {
      arbitrary: withCorruptEntry(
        perProvider(credentialRecord),
        unknownProviderId,
        credentialRecord,
      ),
      weight: 2,
    },
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

// Removal is one corrupt class next to the wrong kinds, so a patched field
// is removed a third of the time.
const corruptPatch = fc.record(
  Object.fromEntries(
    Object.entries(CORRUPT_FIELDS).map(([field, arb]) => [
      field,
      fc.option(arb, { nil: ABSENT, freq: 3 }),
    ]),
  ),
  { requiredKeys: [] },
);

/** The fields a patch changes: removing a key the blob never had (the
 *  optional `style`) changes nothing. */
function corruptedFields(valid: SettingsV1, patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter(
    (field) => patch[field] !== ABSENT || Object.hasOwn(valid, field),
  );
}

/** A selection aimed at one of the blob's OWN credential entries, so the entry
 *  that receives the encodings and the engine is exercised. The keys of a
 *  corrupt map include unknown ids; those are taken first half the time, so
 *  the unknown-id case is not rare. */
const linkedSelection = fc.record({
  index: fc.nat(),
  unknownFirst: fc.boolean(),
  voiceId: fc.oneof(fc.string({ minLength: 1 }), wrongKind("string")),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A valid v1 blob with at least one field corrupted or removed; the stamp
 *  stays 1 so the step always converts (a corrupt stamp is its own case).
 *  Half the blobs aim their selected voice at their own credential map (the
 *  link; a map that is not a record, or is empty, has no entry to aim at),
 *  the other half keep the two independent. */
export const corruptSettingsV1: fc.Arbitrary<Record<string, unknown>> = fc
  .tuple(settingsV1, corruptPatch, fc.option(linkedSelection, { freq: 2 }))
  .filter(([valid, patch]) => corruptedFields(valid, patch).length > 0)
  .map(([valid, patch, link]) => {
    const merged: Record<string, unknown> = { ...valid, ...patch };
    const blob = Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== ABSENT));
    if (link === null || !isRecord(blob.credentials)) return blob;
    const ids = Object.keys(blob.credentials);
    const unknown = ids.filter((id) => !PROVIDER_IDS.some((known) => known === id));
    const pool = link.unknownFirst && unknown.length > 0 ? unknown : ids;
    const providerId = pool[link.index % pool.length];
    if (providerId === undefined) return blob;
    const selectedVoice = { providerId, voiceId: link.voiceId };
    // A blob whose only corrupt field is the selection must stay corrupt.
    const onlyVoiceCorrupt = corruptedFields(valid, patch).every((f) => f === "selectedVoice");
    if (onlyVoiceCorrupt && isValidVoice(selectedVoice)) return blob;
    return { ...blob, selectedVoice };
  });
