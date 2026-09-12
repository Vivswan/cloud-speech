import { z } from "zod";
import { i18n } from "@/lib/i18n-runtime";
import type { ErrorPayload } from "@/lib/protocol";
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

// Pure on purpose (no storage, injected timestamps) so the import/export
// contract is unit-testable; the UI owns file IO and applying results.

export const EXPORT_APP_ID = "cloud-speech";

/** A real export is a few KB, so 1 MB is generous; larger files are refused
 *  before being read into popup memory. */
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
  | {
      ok: false;
      error: ImportErrorCode;
      /** What the parser saw, for Details: the JSON error, the envelope
       *  fields that failed, or the versions that did not match. */
      detail: string;
    };

export function describeImportFailure(
  result: Extract<ParseImportResult, { ok: false }>,
): ErrorPayload {
  const title = i18n.t("settings.backup_import_failed_title");
  switch (result.error) {
    case "not-json":
      return { title, message: i18n.t("settings.backup_import_not_json"), detail: result.detail };
    case "wrong-app":
      return { title, message: i18n.t("settings.backup_import_wrong_app"), detail: result.detail };
    case "future-version":
      return {
        title,
        message: i18n.t("settings.backup_import_future_version"),
        detail: result.detail,
      };
    case "nothing-salvageable":
      return { title, message: i18n.t("settings.backup_import_nothing"), detail: result.detail };
  }
}

function describeValue(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}

// The envelope is required: every SettingsSchema field defaults, so
// `parse({})` succeeds, and lenient acceptance would let any JSON replace
// the settings with defaults.
const ExportEnvelopeSchema = z.object({
  app: z.literal(EXPORT_APP_ID),
  version: z.number().int().min(1),
  exportedAt: z.string(),
  settings: z.unknown(),
});

/** Only the parser's own trailing position is trusted: V8's other form
 *  quotes the offending source before "is not valid JSON", so a position
 *  found anywhere else in the message could be the pasted text talking.
 *
 *  V8       -> "... in JSON at position N (line L column C)"   (line and column are newer than the position)
 *  Firefox  -> "... at line L column C of the JSON data"
 */
const V8_POSITION = /\b(?:in|after) JSON at position (\d+)(?: \(line (\d+) column (\d+)\))?$/;
const FIREFOX_POSITION = /\bat line (\d+) column (\d+) of the JSON data$/;

/** Never the message itself: Chromium quotes the offending source in it, and
 *  a key pasted in place of a file would reach Details and the bug report
 *  that way. */
export function describeParseError(error: unknown): string {
  const name = error instanceof Error ? error.name : "Error";
  const message = error instanceof Error ? error.message : "";
  const v8 = V8_POSITION.exec(message);
  const firefox = FIREFOX_POSITION.exec(message);
  const [line, column] = v8 ? [v8[2], v8[3]] : [firefox?.[1], firefox?.[2]];
  const where = [
    v8 ? `position ${v8[1]}` : undefined,
    line && column ? `line ${line} column ${column}` : undefined,
  ].filter(Boolean);
  return where.length === 0 ? name : `${name} at ${where.join(", ")}`;
}

export function parseImport(text: string): ParseImportResult {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: "not-json", detail: describeParseError(error) };
  }

  const envelope = ExportEnvelopeSchema.safeParse(data);
  if (!envelope.success) {
    const fields = envelope.error.issues.map((issue) => issue.path.join(".") || "(root)");
    return {
      ok: false,
      error: "wrong-app",
      detail: `Not an export envelope: ${fields.join(", ")}`,
    };
  }
  const tooNew = (version: number) =>
    `File settings schema v${version}; this build reads up to v${SETTINGS_VERSION}`;
  if (envelope.data.version > SETTINGS_VERSION) {
    return { ok: false, error: "future-version", detail: tooNew(envelope.data.version) };
  }

  const fileSettings = envelope.data.settings;
  if (!fileSettings || typeof fileSettings !== "object" || Array.isArray(fileSettings)) {
    return {
      ok: false,
      error: "nothing-salvageable",
      detail: `"settings" is ${describeValue(fileSettings)}, not an object`,
    };
  }

  // The blob's own schemaVersion wins; files exported before blobs carried
  // one fall back to the envelope version.
  const versioned =
    "schemaVersion" in fileSettings
      ? fileSettings
      : { ...fileSettings, schemaVersion: envelope.data.version };
  const blobVersion = peekSchemaVersion(versioned);
  if (blobVersion > SETTINGS_VERSION) {
    return { ok: false, error: "future-version", detail: tooNew(blobVersion) };
  }
  const { patch, dropped } = salvageSettingsPatch(upgradeSettingsBlob(versioned));
  return {
    ok: true,
    settings: SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...patch }),
    patch,
    exportedAt: Number.isNaN(Date.parse(envelope.data.exportedAt))
      ? null
      : envelope.data.exportedAt,
    droppedFields: dropped,
    // Any non-blank value counts: even a partial credential set is sensitive
    // content worth disclosing.
    providersWithCredentials: PROVIDER_IDS.filter((id) =>
      Object.values(patch.perProvider?.[id]?.credentials ?? {}).some(
        (value) => value.trim() !== "",
      ),
    ),
  };
}

/** Per-field on purpose: the exhaustive Settings result forces a merge
 *  decision whenever the schema grows. Scalars follow key presence (`in`),
 *  not definedness, so a merge never default-clobbers a field the file did
 *  not carry. */
export function mergeSettings(current: Settings, patch: Partial<Settings>): Settings {
  const scalar = <K extends keyof Settings>(key: K): Settings[K] =>
    key in patch ? (patch[key] as Settings[K]) : current[key];

  return SettingsSchema.parse({
    schemaVersion: SETTINGS_VERSION,
    // Records merge per entry: file entries win, current-only entries stay. A
    // provider entry is one value, so the file's verification flag only ever
    // describes the file's own credentials.
    perProvider: { ...current.perProvider, ...patch.perProvider },
    voicesByLanguage: { ...current.voicesByLanguage, ...patch.voicesByLanguage },
    favorites: [...new Set([...current.favorites, ...(patch.favorites ?? [])])],
    selection: scalar("selection"),
    speed: scalar("speed"),
    pitch: scalar("pitch"),
    volumeGainDb: scalar("volumeGainDb"),
    language: scalar("language"),
    theme: scalar("theme"),
    uiLanguage: scalar("uiLanguage"),
    // The Record intersection forces even optional schema fields to be listed
    // here; `satisfies Settings` alone would let a future optional field
    // silently fall out of the merge.
  } satisfies Settings & Record<keyof Settings, unknown>);
}
