import { browser } from "#imports";
import { enqueueWrite, voiceIssuesItem } from "@/lib/storage";
import type { ProviderId } from "@/providers/types";
import type { SettingsMigration } from "./index";
import { peekSchemaVersion } from "./version";

// ---------------------------------------------------------------------------
// Step 1: schema v1 -> v2, the v2 shapes frozen here for a later step to upgrade further.
// Presence-preserving: a key absent from the v1 blob stays absent, so an import
// merge never clobbers a field the file never carried.
//
//   selectedVoice + model + style                      -> one `selection` value
//   credentials / credentialsValid / enabledProviders  -> one `perProvider` entry per provider
//   readAloudEncoding / downloadEncoding               -> the selected voice's provider, the only one they were used with
//   flat `provider:voice:model` issue keys (local)     -> nested record with the error text as leaf; the current reader decodes that leaf as no issue
// ---------------------------------------------------------------------------

/** The provider roster as it stood at v1; a v1 blob can only name these. */
const V1_PROVIDER_IDS = ["polly", "azure", "google", "openai", "custom"] as const;

type V1ProviderId = (typeof V1_PROVIDER_IDS)[number];

/** v1 defaulted `model`, so a blob without the key meant this value, not a corruption. */
const V1_DEFAULT_MODEL = "neural";

/** Everything but the flags is the v1 value as stored: the v2 schema, not this step, decides what is valid. */
export interface ProviderPrefsV2 {
  credentials: unknown;
  verified: boolean;
  enabled: boolean;
  readAloudEncoding?: unknown;
  downloadEncoding?: unknown;
  lastModel?: unknown;
}

export interface SelectionV2 {
  providerId: unknown;
  voiceId: unknown;
  model: unknown;
  style?: unknown;
}

/** Apart from the two flags (perProviderFrom), the step reshapes and never validates: a corrupt v1
 *  value arrives as a corrupt v2 field for the v2 schema's fallbacks to handle. A valid-looking
 *  replacement made up here would instead silently win an import merge or a backup restore over
 *  this device's real value. */
export interface SettingsV2 {
  schemaVersion: 2;
  perProvider?: unknown;
  selection?: unknown;
  voicesByLanguage?: unknown;
  favorites?: unknown;
  speed?: unknown;
  pitch?: unknown;
  volumeGainDb?: unknown;
  language?: unknown;
  theme?: unknown;
  uiLanguage?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isV1ProviderId(value: unknown): value is V1ProviderId {
  return V1_PROVIDER_IDS.some((id) => id === value);
}

function composeSelection(
  voice: Record<string, unknown>,
  raw: Record<string, unknown>,
): SelectionV2 {
  return {
    providerId: voice.providerId,
    voiceId: voice.voiceId,
    model: "model" in raw ? raw.model : V1_DEFAULT_MODEL,
    ...("style" in raw ? { style: raw.style } : {}),
  };
}

/** `in`, not truthiness: a null `selectedVoice` means the user had no voice and must carry over. */
function selectionFrom(raw: Record<string, unknown>): Pick<SettingsV2, "selection"> {
  if (!("selectedVoice" in raw)) return {};
  const voice = raw.selectedVoice;
  return { selection: isRecord(voice) ? composeSelection(voice, raw) : voice };
}

/** The credential map is the source of entries: every blob the app wrote has a record for each
 *  provider it holds a flag for, so a flag without one forms no entry. A corrupt flag reads as
 *  false, the direction Save & test undoes. */
function perProviderFrom(raw: Record<string, unknown>): Pick<SettingsV2, "perProvider"> {
  if (!("credentials" in raw)) return {};
  const credentials = raw.credentials;
  if (!isRecord(credentials)) return { perProvider: credentials };
  const valid = isRecord(raw.credentialsValid) ? raw.credentialsValid : {};
  const enabled = isRecord(raw.enabledProviders) ? raw.enabledProviders : {};
  const selected = isRecord(raw.selectedVoice) ? composeSelection(raw.selectedVoice, raw) : null;
  const encodings: Pick<ProviderPrefsV2, "readAloudEncoding" | "downloadEncoding"> = {
    ...("readAloudEncoding" in raw ? { readAloudEncoding: raw.readAloudEncoding } : {}),
    ...("downloadEncoding" in raw ? { downloadEncoding: raw.downloadEncoding } : {}),
  };
  // fromEntries defines OWN properties even for a "__proto__" key; indexed
  // assignment would set the prototype instead.
  const perProvider: Record<string, ProviderPrefsV2> = Object.fromEntries(
    Object.entries(credentials).map(([id, record]): [string, ProviderPrefsV2] => [
      id,
      {
        credentials: record,
        verified: valid[id] === true,
        enabled: enabled[id] === true,
        ...(selected?.providerId === id ? { ...encodings, lastModel: selected.model } : {}),
      },
    ]),
  );
  return { perProvider };
}

export function settingsV2FromV1(raw: Record<string, unknown>): SettingsV2 {
  const carried = (
    [
      "voicesByLanguage",
      "favorites",
      "speed",
      "pitch",
      "volumeGainDb",
      "language",
      "theme",
      "uiLanguage",
    ] as const
  )
    .filter((key) => key in raw)
    .map((key) => [key, raw[key]] as const);
  return {
    schemaVersion: 2,
    ...perProviderFrom(raw),
    ...selectionFrom(raw),
    ...Object.fromEntries(carried),
  };
}

/** Provider is before the FIRST colon, model after the LAST: voice ids may contain colons. A
 *  model with a colon cannot be told apart and lands on the wrong row; its mark reappears on the
 *  next failed preview or scan. */
export function splitVoiceIssueKey(
  key: string,
): { providerId: ProviderId; voiceId: string; model: string } | null {
  const first = key.indexOf(":");
  const last = key.lastIndexOf(":");
  if (first === -1 || first === last) return null;
  const providerId = key.slice(0, first);
  const voiceId = key.slice(first + 1, last);
  const model = key.slice(last + 1);
  if (!isV1ProviderId(providerId) || !voiceId || !model) return null;
  return { providerId, voiceId, model };
}

/** provider -> voice -> model, with the provider's error text as the leaf. */
export type VoiceIssueCacheV2 = Partial<
  Record<V1ProviderId, Record<string, Record<string, string>>>
>;

export function nestVoiceIssues(raw: unknown): VoiceIssueCacheV2 | null {
  if (!isRecord(raw)) return null;
  const entries = Object.entries(raw);
  if (!entries.some(([, reason]) => typeof reason === "string")) return null;
  const nested: VoiceIssueCacheV2 = {};
  for (const [key, reason] of entries) {
    if (typeof reason !== "string") continue;
    const ref = splitVoiceIssueKey(key);
    if (!ref) continue;
    // Computed keys in literals make OWN properties even for "__proto__";
    // indexed assignment would set the prototype instead.
    const byVoice = nested[ref.providerId] ?? {};
    const byModel = Object.hasOwn(byVoice, ref.voiceId) ? byVoice[ref.voiceId] : {};
    nested[ref.providerId] = { ...byVoice, [ref.voiceId]: { ...byModel, [ref.model]: reason } };
  }
  return nested;
}

export const toPerProvider: SettingsMigration = {
  from: 1,
  description: "settings v1 -> v2: one selection value, one entry per provider",
  up(raw) {
    if (!isRecord(raw)) return { schemaVersion: 2 } satisfies SettingsV2;
    // The runner's classification decides: a malformed stamp it reads as v1 is converted here too.
    if (peekSchemaVersion(raw) !== 1) return raw;
    return settingsV2FromV1(raw);
  },
  async atStartup() {
    await enqueueWrite(async () => {
      const { voiceIssues } = await browser.storage.local.get("voiceIssues");
      const nested = nestVoiceIssues(voiceIssues);
      if (nested !== null) await voiceIssuesItem.setValue(nested);
    });
  },
};
