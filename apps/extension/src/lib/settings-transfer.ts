import { z } from "zod";
import {
  DEFAULT_SETTINGS,
  SETTINGS_VERSION,
  type Settings,
  SettingsSchema,
  salvageSettingsPatch,
} from "@/lib/storage";
import { upgradeSettingsBlob } from "@/migrations";
import { peekSchemaVersion } from "@/migrations/version";
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

export function parseImport(text: string): ParseImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: "not-json" };
  }

  const envelope = ExportEnvelopeSchema.safeParse(data);
  if (!envelope.success) return { ok: false, error: "wrong-app" };
  if (envelope.data.version > SETTINGS_VERSION) return { ok: false, error: "future-version" };

  const fileSettings = envelope.data.settings;
  if (!fileSettings || typeof fileSettings !== "object" || Array.isArray(fileSettings)) {
    return { ok: false, error: "nothing-salvageable" };
  }

  // The blob's own schemaVersion wins; files exported before blobs carried
  // one fall back to the envelope version.
  const versioned =
    "schemaVersion" in fileSettings
      ? fileSettings
      : { ...fileSettings, schemaVersion: envelope.data.version };
  if (peekSchemaVersion(versioned) > SETTINGS_VERSION)
    return { ok: false, error: "future-version" };
  const { patch, dropped } = salvageSettingsPatch(upgradeSettingsBlob(versioned));
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
      Object.values(patch.perProvider?.[id]?.credentials ?? {}).some(
        (value) => value.trim() !== "",
      ),
    ),
  };
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

  return SettingsSchema.parse({
    schemaVersion: SETTINGS_VERSION,
    // Records merge per entry: file entries win, current-only entries stay.
    // A provider entry is one value, so the file's verification flag can only
    // ever describe the file's own credentials: this device's flag never
    // vouches for keys the file changed, and a flag never arrives alone.
    perProvider: { ...current.perProvider, ...patch.perProvider },
    voicesByLanguage: { ...current.voicesByLanguage, ...patch.voicesByLanguage },
    // Union, current order first.
    favorites: [...new Set([...current.favorites, ...(patch.favorites ?? [])])],
    selection: scalar("selection"),
    speed: scalar("speed"),
    pitch: scalar("pitch"),
    volumeGainDb: scalar("volumeGainDb"),
    language: scalar("language"),
    theme: scalar("theme"),
    uiLanguage: scalar("uiLanguage"),
    // The Record intersection forces even OPTIONAL schema fields to be listed
    // here; `satisfies Settings` alone would let a future optional field
    // silently fall out of the merge.
  } satisfies Settings & Record<keyof Settings, unknown>);
}
