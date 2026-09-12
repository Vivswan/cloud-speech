import { EXTENSION_LOCALE_IDS } from "@cloud-speech/constants";
import { z } from "zod";
import { storage } from "#imports";
import { ErrorPayloadSchema } from "@/lib/protocol";
import { SettingsNewerError, upgradeSettingsBlob } from "@/migrations";
import { peekSchemaVersion } from "@/migrations/version";
import { getProvider } from "@/providers";
import { type NormalizedVoiceSchema, PROVIDER_IDS, type ProviderId } from "@/providers/types";

// Bump SETTINGS_VERSION together with a new upgrade step in the runner
// imported above. Strict on purpose: a newer build's field fails the whole
// parse, and salvage then keeps the known fields.

export const SETTINGS_VERSION = 2;

export const VoiceRefSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  voiceId: z.string().min(1),
});

export type VoiceRef = z.infer<typeof VoiceRefSchema>;

/** The unit an issue is recorded for: a dual-engine voice can work on neural
 *  and fail on standard. */
export const VoiceModelRefSchema = VoiceRefSchema.extend({
  model: z.string().min(1),
});

export type VoiceModelRef = z.infer<typeof VoiceModelRefSchema>;

/** Voice, engine, and style as one value, so a voice change can never leave a
 *  model or style behind that belongs to another voice. The style falls back
 *  on its own: a corrupt one must not cost the voice. */
export const SelectionSchema = VoiceModelRefSchema.extend({
  style: z.string().optional().catch(undefined),
});

export type Selection = z.infer<typeof SelectionSchema>;

/** Not strict, unlike SettingsSchema: salvage works per entry, so an unknown
 *  key from a later build would cost the whole entry.
 *
 *  credentials missing      -> no entry, so it can never replace a real one on a merge
 *  any other field corrupt  -> falls back alone; the keys beside it survive
 */
export const ProviderPrefsSchema = z.object({
  credentials: z.record(z.string(), z.string()),
  /** The stored credentials passed Save & test. Only true with complete
   *  credentials; PerProviderSchema clears it otherwise. */
  verified: z.boolean().default(false).catch(false),
  enabled: z.boolean().default(false).catch(false),
  readAloudEncoding: z.string().optional().catch(undefined),
  downloadEncoding: z.string().optional().catch(undefined),
  lastModel: z.string().optional().catch(undefined),
});

export type ProviderPrefs = z.infer<typeof ProviderPrefsSchema>;

export type PerProvider = Partial<Record<ProviderId, ProviderPrefs>>;

/** A transform, not a refinement: a verified flag over incomplete credentials
 *  is cleared, never a reason to drop the entry. */
const PerProviderSchema = z
  .partialRecord(z.enum(PROVIDER_IDS), ProviderPrefsSchema)
  .transform((record): PerProvider => {
    const normalized: PerProvider = {};
    for (const id of PROVIDER_IDS) {
      const prefs = record[id];
      if (!prefs) continue;
      normalized[id] =
        prefs.verified && !getProvider(id).hasCredentials(prefs.credentials)
          ? { ...prefs, verified: false }
          : prefs;
    }
    return normalized;
  });

export const SettingsSchema = z.strictObject({
  schemaVersion: z.literal(SETTINGS_VERSION).default(SETTINGS_VERSION),
  perProvider: PerProviderSchema.default({}),
  selection: SelectionSchema.nullable().default(null),
  /** The user's picks (selectVoice, and the pick handed over from a
   *  single-provider install). The automatic fallback never writes it, so
   *  lib/reconcile.ts reads it as proof the user chose a voice. */
  voicesByLanguage: z.record(z.string(), VoiceRefSchema).default({}),
  /** Composite `providerId:voiceId` keys. */
  favorites: z.array(z.string()).default([]),
  speed: z.number().default(1),
  pitch: z.number().default(0),
  volumeGainDb: z.number().default(0),
  language: z.string().default("en-US"),
  theme: z.enum(["light", "dark", "system"]).default("system"),
  /** The UI's display language, not the voice locale (`language`); "auto"
   *  follows the browser. */
  uiLanguage: z.enum(["auto", ...EXTENSION_LOCALE_IDS]).default("auto"),
});

export type Settings = z.infer<typeof SettingsSchema>;

export type SettingsInput = z.input<typeof SettingsSchema>;

export type UiLanguage = Settings["uiLanguage"];

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

// Always local: the toggle that picks the settings area must not itself sync.
export const syncEnabledItem = storage.defineItem<boolean>("local:syncEnabled", {
  fallback: true,
});

// Any schema version may be stored (an older build, a newer device);
// decodeStored() is the only way to turn it into Settings.
const settingsSyncItem = storage.defineItem<unknown>("sync:settings", { fallback: null });

const settingsLocalItem = storage.defineItem<unknown>("local:settings", { fallback: null });

export const voicesSessionItem = storage.defineItem<z.infer<typeof NormalizedVoiceSchema>[]>(
  "session:voices",
  { fallback: [] },
);

/** Stored exactly as the background described the failure for its notice; the
 *  picker shows it as it is, so nothing is re-described on read. */
const VoiceIssueSchema = ErrorPayloadSchema;

export type VoiceIssue = z.infer<typeof VoiceIssueSchema>;

/** provider -> voice -> model -> the described failure. A leaf is cleared by
 *  a successful fresh synthesis (a read or preview, never a cache hit) or
 *  scan of that voice on that engine, so a fixed account heals itself. */
export type VoiceIssues = Partial<Record<ProviderId, Record<string, Record<string, VoiceIssue>>>>;

// Local, not session: session storage is wiped on every extension reload (in
// dev, every rebuild). Any build may have written the value;
// decodeVoiceIssues() is the only reader.
export const voiceIssuesItem = storage.defineItem<unknown>("local:voiceIssues", {
  fallback: null,
});

/** Voice and model ids are provider-supplied strings, so a name like
 *  "constructor" must read as absent, not as Object's method. */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A leaf that is not a described failure reads as no issue: the cache is
 *  rebuilt by use, so the mark returns with the next failed preview or scan.
 *  Built from entries, never by indexed assignment: a voice named
 *  "__proto__" must become an own property. */
export function decodeVoiceIssues(raw: unknown): VoiceIssues {
  if (!isRecord(raw)) return {};
  const providers = PROVIDER_IDS.flatMap((providerId) => {
    const byVoice = own(raw, providerId);
    if (!isRecord(byVoice)) return [];
    const voices = Object.entries(byVoice).flatMap(([voiceId, byModel]) => {
      if (!isRecord(byModel)) return [];
      const models = Object.entries(byModel).flatMap(([model, leaf]) => {
        const parsed = VoiceIssueSchema.safeParse(leaf);
        return parsed.success ? [[model, parsed.data] as const] : [];
      });
      return models.length === 0 ? [] : [[voiceId, Object.fromEntries(models)] as const];
    });
    return voices.length === 0 ? [] : [[providerId, Object.fromEntries(voices)] as const];
  });
  return Object.fromEntries(providers);
}

export function readVoiceIssues(): Promise<VoiceIssues> {
  return voiceIssuesItem.getValue().then(decodeVoiceIssues);
}

export function watchVoiceIssues(callback: (issues: VoiceIssues) => void): () => void {
  return voiceIssuesItem.watch((raw) => callback(decodeVoiceIssues(raw)));
}

export function voiceIssue(issues: VoiceIssues, ref: VoiceModelRef): VoiceIssue | undefined {
  return own(own(issues[ref.providerId], ref.voiceId), ref.model);
}

/** The same description, field by field: a failure recorded again as the
 *  scan re-flags a family is no change to write. */
function sameIssue(a: VoiceIssue, b: VoiceIssue): boolean {
  return (
    a.title === b.title &&
    a.message === b.message &&
    a.detail === b.detail &&
    a.action?.label === b.action?.label &&
    a.action?.url === b.action?.url
  );
}

/** Returns the SAME object when nothing changes, so callers can skip the
 *  write. */
export function withVoiceIssue(
  issues: VoiceIssues,
  ref: VoiceModelRef,
  issue: VoiceIssue | null,
): VoiceIssues {
  const byVoice = issues[ref.providerId] ?? {};
  const byModel = own(byVoice, ref.voiceId) ?? {};
  const current = own(byModel, ref.model);
  const unchanged =
    current === undefined ? issue === null : issue !== null && sameIssue(current, issue);
  if (unchanged) return issues;
  const { [ref.model]: _removed, ...otherModels } = byModel;
  const nextModels = issue === null ? otherModels : { ...otherModels, [ref.model]: issue };
  const { [ref.voiceId]: _removedVoice, ...otherVoices } = byVoice;
  const nextVoices =
    Object.keys(nextModels).length === 0
      ? otherVoices
      : { ...otherVoices, [ref.voiceId]: nextModels };
  const { [ref.providerId]: _removedProvider, ...otherProviders } = issues;
  return Object.keys(nextVoices).length === 0
    ? otherProviders
    : { ...otherProviders, [ref.providerId]: nextVoices };
}

// Same cross-context lock as settings: popup previews, background playback,
// and scans all read-modify-write this cache.
export function mergeVoiceIssues(
  batch: readonly (VoiceModelRef & { issue: VoiceIssue | null })[],
): Promise<void> {
  return enqueueWrite(async () => {
    const issues = await readVoiceIssues();
    const next = batch.reduce((acc, entry) => withVoiceIssue(acc, entry, entry.issue), issues);
    if (next !== issues) await voiceIssuesItem.setValue(next);
  });
}

export function recordVoiceIssue(ref: VoiceModelRef, issue: VoiceIssue): Promise<void> {
  return mergeVoiceIssues([{ ...ref, issue }]);
}

export function clearVoiceIssue(ref: VoiceModelRef): Promise<void> {
  return mergeVoiceIssues([{ ...ref, issue: null }]);
}

async function activeItem() {
  const syncEnabled = await syncEnabledItem.getValue();
  return syncEnabled ? settingsSyncItem : settingsLocalItem;
}

/** Record fields are salvaged entry by entry: one malformed provider entry
 *  must not erase the others. `schemaVersion` belongs to the upgrade chain
 *  and is never part of a patch. */
export function salvageSettingsPatch(raw: unknown): {
  patch: Partial<Settings>;
  dropped: string[];
} {
  const patch: Record<string, unknown> = {};
  const dropped: string[] = [];
  if (!raw || typeof raw !== "object") return { patch: {}, dropped };

  for (const [key, fieldSchema] of Object.entries(SettingsSchema.shape)) {
    if (key === "schemaVersion") continue;
    const value = (raw as Record<string, unknown>)[key];
    if (value === undefined) continue;
    const field = fieldSchema.safeParse(value);
    if (field.success) {
      patch[key] = field.data;
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const entries: Record<string, unknown> = {};
      for (const [entryKey, entryValue] of Object.entries(value)) {
        const single = fieldSchema.safeParse({ [entryKey]: entryValue });
        if (single.success) Object.assign(entries, single.data);
      }
      const rescued = fieldSchema.safeParse(entries);
      if (rescued.success && Object.keys(entries).length > 0) patch[key] = rescued.data;
    }
    // Rescued or not, something present was lost, so the key is reported.
    dropped.push(key);
  }
  return { patch: patch as Partial<Settings>, dropped };
}

function salvageKnownFields(raw: unknown): Settings {
  return SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...salvageSettingsPatch(raw).patch });
}

/** Field-by-field salvage rather than a whole-object parse: one bad field
 *  would otherwise discard everything, and the next write would erase valid
 *  credentials for good. Throws SettingsNewerError for a blob a newer build
 *  wrote; decodeStored() is the reader that stays readable then. */
export function salvageSettings(raw: unknown): Settings {
  const upgraded = upgradeSettingsBlob(raw);
  const parsed = SettingsSchema.safeParse(upgraded);
  if (parsed.success) return parsed.data;
  console.warn("Settings failed validation; salvaged valid fields");
  return salvageKnownFields(upgraded);
}

export interface SettingsRecord {
  settings: Settings;
  /** Above SETTINGS_VERSION: a newer build wrote the blob, and this build
   *  must not write it back. */
  storedVersion: number;
}

/** The one decoder. A newer build's blob stays readable through its known
 *  fields, so credentials and playback keep working. */
function decodeStored(raw: unknown): SettingsRecord {
  if (raw === null) return { settings: DEFAULT_SETTINGS, storedVersion: SETTINGS_VERSION };
  const storedVersion = peekSchemaVersion(raw);
  if (storedVersion > SETTINGS_VERSION) {
    return { settings: salvageKnownFields(raw), storedVersion };
  }
  return { settings: salvageSettings(raw), storedVersion };
}

export async function readSettingsRecord(): Promise<SettingsRecord> {
  const item = await activeItem();
  const record = decodeStored(await item.getValue());
  if (record.storedVersion < SETTINGS_VERSION) persistUpgradeOnce();
  return record;
}

export async function getSettings(): Promise<Settings> {
  return (await readSettingsRecord()).settings;
}

/** Raw, for handing to another install: its own decoder must see the real
 *  version. */
export async function readStoredSettingsBlob(): Promise<unknown> {
  return (await activeItem()).getValue();
}

// One in-flight write-back at a time: every read of an old blob would
// otherwise queue its own. Re-reads under the lock, since a write may have
// landed (or a newer blob synced in) since the read that scheduled this.
let upgradeWriteBack: Promise<void> | null = null;
function persistUpgradeOnce(): void {
  if (upgradeWriteBack !== null) return;
  upgradeWriteBack = enqueueWrite(async () => {
    const item = await activeItem();
    const raw = await item.getValue();
    if (raw === null || peekSchemaVersion(raw) >= SETTINGS_VERSION) return;
    await item.setValue(salvageSettings(raw));
  })
    .catch((error) => console.warn("Writing back upgraded settings failed", error))
    .finally(() => {
      upgradeWriteBack = null;
    });
}

// Web Locks, not an in-memory chain: the popup and the service worker are
// separate JS contexts sharing one extension origin. Grants are FIFO, so one
// lock also serializes within a context; one name per independent store keeps
// unrelated writers apart.
//   Web Locks since Chrome 69 / Firefox 96  -> below the manifest floors in wxt.config.ts
export function withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return navigator.locks.request(name, operation) as Promise<T>;
}

export function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  return withLock("cloud-speech-settings-write", operation);
}

/** Callers hold the write lock. Rejects with SettingsNewerError so no writer
 *  here can downgrade another device's settings. */
async function readForWrite() {
  const item = await activeItem();
  const record = decodeStored(await item.getValue());
  if (record.storedVersion > SETTINGS_VERSION) throw new SettingsNewerError(record.storedVersion);
  return { item, current: record.settings };
}

export function setSettings(settings: Settings): Promise<void> {
  return enqueueWrite(async () => {
    const { item } = await readForWrite();
    await item.setValue(SettingsSchema.parse(settings));
  });
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return updateSettingsWith(() => patch);
}

/** For any patch that depends on prior state (credential maps, favorites
 *  toggles, anything computed before an `await`): the updater sees the fresh
 *  settings under the lock. */
export function updateSettingsWith(
  updater: (current: Settings) => Partial<Settings>,
): Promise<Settings> {
  return enqueueWrite(async () => {
    const { item, current } = await readForWrite();
    const next = SettingsSchema.parse({ ...current, ...updater(current) });
    await item.setValue(next);
    return next;
  });
}

/** One slot: the settings from before the last import. */
export interface SettingsBackup {
  /** ISO 8601 */
  savedAt: string;
  settings: Settings;
}

/** LOCAL on purpose: the snapshot is this device's undo, not shared state. */
export const importBackupItem = storage.defineItem<SettingsBackup | null>("local:importBackup", {
  fallback: null,
});

/** Snapshot and replacement happen under one lock, so no other write can
 *  land between them. */
export function setSettingsWithBackup(
  compute: (current: Settings) => Settings,
  now: Date,
): Promise<Settings> {
  return enqueueWrite(async () => {
    const { item, current } = await readForWrite();
    // A failed import (sync quota) must not cost the user their restore
    // point: parse before touching the slot, and put the previous snapshot
    // back on failure.
    const next = SettingsSchema.parse(compute(current));
    const previous = await importBackupItem.getValue();
    await importBackupItem.setValue({ savedAt: now.toISOString(), settings: current });
    try {
      await item.setValue(next);
    } catch (error) {
      try {
        await importBackupItem.setValue(previous);
      } catch {
        // Best effort: the original write error is the one worth surfacing.
      }
      throw error;
    }
    return next;
  });
}

/** A snapshot that salvages to nothing is cleared without restoring: pure
 *  defaults over real settings would be worse than refusing. One from a newer
 *  build rejects with SettingsNewerError and keeps the slot. */
export function restoreSettingsBackup(): Promise<Settings | null> {
  return enqueueWrite(async () => {
    const backup = await importBackupItem.getValue();
    if (backup === null) return null;
    const { patch } = salvageSettingsPatch(upgradeSettingsBlob(backup.settings));
    if (Object.keys(patch).length === 0) {
      await importBackupItem.removeValue();
      return null;
    }
    const restored = SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...patch });
    const { item } = await readForWrite();
    await item.setValue(restored);
    await importBackupItem.removeValue();
    return restored;
  });
}

/** The slot holds plaintext credentials, so wiping keys off this machine must
 *  be able to include it. */
export function discardSettingsBackup(): Promise<void> {
  return enqueueWrite(() => importBackupItem.removeValue());
}

/** Both areas, since the sync toggle can flip between emits. */
export function watchSettingsRecord(callback: (record: SettingsRecord) => void): () => void {
  const emit = async () => callback(await readSettingsRecord());
  const unwatchSync = settingsSyncItem.watch(emit);
  const unwatchLocal = settingsLocalItem.watch(emit);
  return () => {
    unwatchSync();
    unwatchLocal();
  };
}

export function watchSettings(callback: (settings: Settings) => void): () => void {
  return watchSettingsRecord((record) => callback(record.settings));
}

/** Copy into the target area, flip the flag, then clear the source: no step
 *  leaves the settings in neither area. Moving a blob is lossless at any
 *  version, so the only version guard is on the one path that overwrites.
 *
 *  enabling over a synced copy a newer build wrote  -> SettingsNewerError
 *  `adoptRemote` (enabling only)                    -> keeps the existing synced copy instead of overwriting it with this device's settings
 */
export function setSyncEnabled(enabled: boolean, opts?: { adoptRemote?: boolean }): Promise<void> {
  return enqueueWrite(async () => {
    const current = await syncEnabledItem.getValue();
    if (current === enabled) return;

    if (enabled) {
      // The synced copy can vanish between the popup's conflict prompt and
      // this call (another device turned sync off); adopting nothing would
      // delete the only remaining settings, so fall through to the copy.
      const remote = await settingsSyncItem.getValue();
      if (remote !== null && opts?.adoptRemote) {
        await syncEnabledItem.setValue(true);
        await settingsLocalItem.removeValue();
        return;
      }
      const remoteVersion = peekSchemaVersion(remote);
      if (remote !== null && remoteVersion > SETTINGS_VERSION) {
        throw new SettingsNewerError(remoteVersion);
      }
    }

    const from = current ? settingsSyncItem : settingsLocalItem;
    const to = enabled ? settingsSyncItem : settingsLocalItem;

    const value = await from.getValue();
    if (value !== null) await to.setValue(value);
    await syncEnabledItem.setValue(enabled);
    if (value !== null) await from.removeValue();
  });
}

/** For the popup's conflict check before enabling sync. A newer stored
 *  version always counts as a conflict: its salvaged fields cannot show what
 *  the blob carries. */
export async function peekSyncedSettings(): Promise<SettingsRecord | null> {
  const raw = await settingsSyncItem.getValue();
  return raw === null ? null : decodeStored(raw);
}

/** Chrome's per-item quota for `storage.sync`. */
export const SYNC_QUOTA_BYTES_PER_ITEM = 8192;

/** Chrome counts key length plus the serialized value in UTF-8 bytes (CJK
 *  settings are about 3x their UTF-16 length). Only for the warning before
 *  enabling sync; the write itself is the authority. */
export function estimateSyncSizeBytes(settings: Settings): number {
  return "settings".length + new TextEncoder().encode(JSON.stringify(settings)).length + 64;
}
