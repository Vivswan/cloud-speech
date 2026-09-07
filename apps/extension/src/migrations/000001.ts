import { browser } from "#imports";
import { enqueueWrite, type VoiceIssues, voiceIssuesItem } from "@/lib/storage";
import type { ProviderId } from "@/providers/types";
import type { SettingsMigration } from "./index";
import { peekSchemaVersion } from "./version";

// ---------------------------------------------------------------------------
// Step 1: schema v1 -> v2.
//  - `selectedVoice` + `model` + `style` become ONE `selection` value.
//  - The three parallel provider maps (`credentials`, `credentialsValid`,
//    `enabledProviders`) and the global `readAloudEncoding`/`downloadEncoding`
//    zip into one `perProvider` entry per provider; the encodings land on the
//    selected voice's provider, the only one they were ever used with.
//  - The local voice-issue cache goes from flat `provider:voice:model` keys to
//    a nested record (startup companion).
// Presence-preserving: a key absent from the v1 blob stays absent (an import
// merge must not clobber a field the file never carried). The v2 shape is
// FROZEN here on purpose; a later step upgrades it further.
// ---------------------------------------------------------------------------

/** The provider roster as it stood at v1; a v1 blob can only name these. */
const V1_PROVIDER_IDS = ["polly", "azure", "google", "openai", "custom"] as const;

type V1ProviderId = (typeof V1_PROVIDER_IDS)[number];

/** The v1 default `model`, for a blob that has no `model` key at all: v1
 *  defaulted the field, so absence WAS this value, not a corruption. */
const V1_DEFAULT_MODEL = "neural";

/** One provider's v2 entry as this step composes it. Everything but the
 *  flags is the v1 value as stored (`unknown`): the v2 schema decides what
 *  is a record of strings, a format or an engine. */
export interface ProviderPrefsV2 {
  credentials: unknown;
  verified: boolean;
  enabled: boolean;
  readAloudEncoding?: unknown;
  downloadEncoding?: unknown;
  lastModel?: unknown;
}

/** The v2 selection as this step composes it from `selectedVoice`, `model`
 *  and `style`, each as stored. */
export interface SelectionV2 {
  providerId: unknown;
  voiceId: unknown;
  model: unknown;
  style?: unknown;
}

/** Schema v2 as first shipped, frozen. Every field but the stamp is optional
 *  here because the step carries only what the v1 blob had. The step
 *  RESHAPES and never validates: a corrupt v1 value arrives in v2 as a
 *  corrupt field or entry, for the v2 schema's salvage to drop AND report,
 *  the same way it treats a corrupt v2 blob. A valid-looking replacement made
 *  up here would instead win an import merge or a backup restore over this
 *  device's real value, silently. */
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

/** `{ selection }` when the blob carries `selectedVoice` (null included: the
 *  user had no voice); a voice that is not a record passes through as it is. */
function selectionFrom(raw: Record<string, unknown>): Pick<SettingsV2, "selection"> {
  if (!("selectedVoice" in raw)) return {};
  const voice = raw.selectedVoice;
  return { selection: isRecord(voice) ? composeSelection(voice, raw) : voice };
}

/** The credential map is THE source of provider entries: one entry per key
 *  of it, carrying that provider's flags and, for the selected provider, the
 *  formats and the engine (the only provider they were ever used with).
 *  Flags without a credential record form no entry (an entry is one value;
 *  every blob the app wrote has the record for each provider it holds a flag
 *  for), so absent credentials mean no field. A corrupt flag reads as false,
 *  the direction Save & test undoes. */
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

/** The flat `provider:voice:model` key the v1 cache used: the provider is
 *  everything before the FIRST colon, the model everything after the LAST
 *  (voice ids may contain colons themselves). A key whose MODEL also has a
 *  colon cannot be told apart from one whose voice id does; it lands on the
 *  wrong row and its mark reappears on the next failed preview or scan. */
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

/** Reshape a flat v1 issue cache; a nested (or empty) one passes through. */
export function nestVoiceIssues(raw: unknown): VoiceIssues | null {
  if (!isRecord(raw)) return null;
  const entries = Object.entries(raw);
  if (!entries.some(([, reason]) => typeof reason === "string")) return null;
  const nested: VoiceIssues = {};
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
    // Already past v1 (this step's own output included): nothing to convert.
    // The runner's classification decides, so a malformed stamp the runner
    // reads as v1 is converted here too instead of being passed through.
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
