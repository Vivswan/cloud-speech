import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  type Settings,
  SettingsSchema,
  salvageSettingsPatch,
} from "@/lib/storage";
import { PROVIDER_IDS, type ProviderId } from "@/providers/types";

// ---------------------------------------------------------------------------
// Settings backup files: build/serialize an export envelope and parse it back.
// PURE on purpose (no storage, injected timestamps) so the whole import/export
// contract is unit-testable; the UI layer owns file IO and applying results.
// ---------------------------------------------------------------------------

export const EXPORT_APP_ID = "cloud-speech";

/** Reject files above this size before reading them into popup memory; a
 *  real export is a few KB, so 1 MB is generous. */
export const MAX_IMPORT_FILE_BYTES = 1_000_000;

export interface ExportEnvelope {
  app: typeof EXPORT_APP_ID;
  version: number;
  /** ISO 8601 */
  exportedAt: string;
  settings: Settings;
}

export function buildExport(settings: Settings, now: Date): ExportEnvelope {
  return {
    app: EXPORT_APP_ID,
    version: SETTINGS_VERSION,
    exportedAt: now.toISOString(),
    settings,
  };
}

export function serializeExport(envelope: ExportEnvelope): string {
  return JSON.stringify(envelope, null, 2);
}

/** "cloud-speech-settings-YYYY-MM-DD.json", in the user's LOCAL date. */
export function exportFilename(now: Date): string {
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `cloud-speech-settings-${now.getFullYear()}-${month}-${day}.json`;
}

export type ImportErrorCode = "not-json" | "wrong-app" | "future-version" | "nothing-salvageable";

export type ParseImportResult =
  | {
      ok: true;
      /** Full settings for Replace: defaults overlaid with `patch`. */
      settings: Settings;
      /** Only the usable keys PRESENT in the file, for Merge. */
      patch: Partial<Settings>;
      exportedAt: string | null;
      droppedFields: string[];
      providersWithCredentials: ProviderId[];
    }
  | { ok: false; error: ImportErrorCode };

// The envelope is REQUIRED: every SettingsSchema field defaults, so
// `parse({})` succeeds - lenient acceptance would let any JSON replace
// settings with defaults.
const ExportEnvelopeSchema = z.object({
  app: z.literal(EXPORT_APP_ID),
  version: z.number().int().min(1),
  exportedAt: z.string(),
  settings: z.unknown(),
});

/** The newest export version parseImport knows how to read. Typed to the
 *  LITERAL version: bumping SETTINGS_VERSION fails compilation here until
 *  an upgrade step is added below. */
const HANDLED_IMPORT_VERSION: 1 = SETTINGS_VERSION;

export function parseImport(text: string): ParseImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "not-json" };
  }

  const envelope = ExportEnvelopeSchema.safeParse(data);
  if (!envelope.success) return { ok: false, error: "wrong-app" };
  if (envelope.data.version > HANDLED_IMPORT_VERSION) return { ok: false, error: "future-version" };

  const fileSettings = envelope.data.settings;
  if (!fileSettings || typeof fileSettings !== "object" || Array.isArray(fileSettings)) {
    return { ok: false, error: "nothing-salvageable" };
  }

  const { patch, dropped } = salvageSettingsPatch(fileSettings);
  return {
    ok: true,
    settings: SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...patch }),
    patch,
    exportedAt: Number.isNaN(Date.parse(envelope.data.exportedAt))
      ? null
      : envelope.data.exportedAt,
    droppedFields: dropped,
    // "Has keys" for the summary means ANY non-blank value: even a partial
    // credential set is sensitive content worth disclosing.
    providersWithCredentials: PROVIDER_IDS.filter((id) =>
      Object.values(patch.credentials?.[id] ?? {}).some((value) => value.trim() !== ""),
    ),
  };
}

function sameCredentialRecord(
  a: Record<string, string> | undefined,
  b: Record<string, string>,
): boolean {
  if (!a) return false;
  const bKeys = Object.keys(b);
  return Object.keys(a).length === bKeys.length && bKeys.every((key) => a[key] === b[key]);
}

/**
 * Merge an import patch over the current settings. Per-field on purpose: the
 * exhaustive Settings result forces a merge decision whenever the schema
 * grows. Scalars follow key PRESENCE (`in`), not definedness, so a merge
 * never default-clobbers a field the file did not carry.
 */
export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  const scalar = <K extends keyof Settings>(key: K): Settings[K] =>
    key in patch ? (patch[key] as Settings[K]) : current[key];

  // A validity flag describes the FILE's credentials, which win the merge
  // below; one arriving WITHOUT its provider's credentials (hand-edited
  // file, or salvage dropped a corrupt entry) would mark this device's
  // untested keys as validated, so it is ignored.
  const credentialsValid = { ...current.credentialsValid };
  for (const [id, valid] of Object.entries(patch.credentialsValid ?? {})) {
    const providerId = id as ProviderId;
    if (patch.credentials?.[providerId]) credentialsValid[providerId] = valid;
  }
  // A provider whose keys the file CHANGED must not inherit this device's
  // validated flag: nothing downstream re-tests credentials (only the
  // explicit Save & test does), so a stale `true` would show Connected for
  // a key that was never checked.
  for (const [id, fileCredentials] of Object.entries(patch.credentials ?? {})) {
    const providerId = id as ProviderId;
    if (patch.credentialsValid && providerId in patch.credentialsValid) continue;
    if (
      fileCredentials &&
      !sameCredentialRecord(current.credentials[providerId], fileCredentials)
    ) {
      credentialsValid[providerId] = false;
    }
  }

  return SettingsSchema.parse({
    // Records merge per entry: file entries win, current-only entries stay.
    credentials: { ...current.credentials, ...patch.credentials },
    credentialsValid,
    enabledProviders: { ...current.enabledProviders, ...patch.enabledProviders },
    voicesByLanguage: { ...current.voicesByLanguage, ...patch.voicesByLanguage },
    // Union, current order first.
    favorites: [...new Set([...current.favorites, ...(patch.favorites ?? [])])],
    selectedVoice: scalar("selectedVoice"),
    model: scalar("model"),
    style: scalar("style"),
    speed: scalar("speed"),
    pitch: scalar("pitch"),
    volumeGainDb: scalar("volumeGainDb"),
    readAloudEncoding: scalar("readAloudEncoding"),
    downloadEncoding: scalar("downloadEncoding"),
    language: scalar("language"),
    theme: scalar("theme"),
    uiLanguage: scalar("uiLanguage"),
    // The Record intersection forces even OPTIONAL schema fields (style) to
    // be listed here; `satisfies Settings` alone would let a future optional
    // field silently fall out of the merge.
  } satisfies Settings & Record<keyof Settings, unknown>);
}
