import { EXTENSION_LOCALE_IDS } from "@cloud-speech/constants";
import { z } from "zod";
import { storage } from "#imports";
import { ErrorPayloadSchema } from "@/lib/protocol";
import { SettingsNewerError, upgradeSettingsBlob } from "@/migrations";
import { peekSchemaVersion } from "@/migrations/version";
import { getProvider } from "@/providers";
import { type NormalizedVoiceSchema, PROVIDER_IDS, type ProviderId } from "@/providers/types";

// ---------------------------------------------------------------------------
// Settings schema: the single persisted settings object. Validated with Zod
// on every read so a corrupt blob degrades to defaults instead of crashing.
// The blob carries its own `schemaVersion`; bump SETTINGS_VERSION together
// with a new upgrade step in the runner imported above. Strict: an unknown
// key fails the whole parse (a newer build's field, a typo), and salvage
// then keeps the known fields.
// ---------------------------------------------------------------------------

export const SETTINGS_VERSION = 2;

export const VoiceRefSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  voiceId: z.string().min(1),
});

export type VoiceRef = z.infer<typeof VoiceRefSchema>;

/** One voice on one engine: the unit a preview auditions and an issue is
 *  recorded for (a dual-engine voice can work on neural and fail on
 *  standard). */
export const VoiceModelRefSchema = VoiceRefSchema.extend({
  model: z.string().min(1),
});

export type VoiceModelRef = z.infer<typeof VoiceModelRefSchema>;

/** The voice AND the engine it is used with, as one value: a voice change
 *  can never leave a model or style behind that belongs to another voice.
 *  The style is advisory and falls back on its own: a corrupt one must not
 *  cost the voice. */
export const SelectionSchema = VoiceModelRefSchema.extend({
  style: z.string().optional().catch(undefined),
});

export type Selection = z.infer<typeof SelectionSchema>;

/** Everything the user has set for one provider: keys, their Save & test
 *  outcome, the enable switch, and the format choices (formats are offered
 *  per provider, so a choice only means something for the provider it was
 *  made for). The credentials are REQUIRED and decide whether the entry
 *  parses (an entry without them is not an entry, so it can never replace a
 *  real one on a merge); every other field falls back on its own (`catch`),
 *  so a corrupt flag or format choice never costs the keys stored next to it.
 *  NOT strict, unlike the settings object: salvage works per entry, so an
 *  unknown key here (a later build's field) would cost the whole entry
 *  instead of being set aside. */
export const ProviderPrefsSchema = z.object({
  credentials: z.record(z.string(), z.string()),
  /** The stored credentials passed Save & test. Only ever true with complete
   *  credentials (the record-level parse below clears it otherwise). */
  verified: z.boolean().default(false).catch(false),
  enabled: z.boolean().default(false).catch(false),
  readAloudEncoding: z.string().optional().catch(undefined),
  downloadEncoding: z.string().optional().catch(undefined),
  /** The engine the user last picked for this provider. */
  lastModel: z.string().optional().catch(undefined),
});

export type ProviderPrefs = z.infer<typeof ProviderPrefsSchema>;

export type PerProvider = Partial<Record<ProviderId, ProviderPrefs>>;

/** "Verified without credentials" cannot be persisted: the parse itself
 *  clears a verified flag whose provider says the credentials are incomplete
 *  (as a transform, not a refinement, so a stale flag never costs the entry). */
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
  /** Source of truth for synthesis. Null until the user picks a voice. */
  selection: SelectionSchema.nullable().default(null),
  /** Last-used voice per language (UX memory for the language filter). */
  voicesByLanguage: z.record(z.string(), VoiceRefSchema).default({}),
  /** Composite `providerId:voiceId` keys. */
  favorites: z.array(z.string()).default([]),
  speed: z.number().default(1),
  pitch: z.number().default(0),
  volumeGainDb: z.number().default(0),
  language: z.string().default("en-US"),
  /** Popup color scheme; "system" follows the OS via prefers-color-scheme. */
  theme: z.enum(["light", "dark", "system"]).default("system"),
  /** DISPLAY language of the extension UI (unrelated to `language`, which is
   *  the voice locale). "auto" follows the browser's UI language; the rest
   *  come from the shared locale table. */
  uiLanguage: z.enum(["auto", ...EXTENSION_LOCALE_IDS]).default("auto"),
});

export type Settings = z.infer<typeof SettingsSchema>;

/** What the schema ACCEPTS: every defaulted field optional, so a partial
 *  literal parses into full Settings. */
export type SettingsInput = z.input<typeof SettingsSchema>;

export type UiLanguage = Settings["uiLanguage"];

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

// ---------------------------------------------------------------------------
// Storage items. The settings object lives in `sync` OR `local`, chosen by a
// user toggle that itself always lives in `local` (it must not sync).
// ---------------------------------------------------------------------------

export const syncEnabledItem = storage.defineItem<boolean>("local:syncEnabled", {
  fallback: true,
});

// Typed `unknown`: the stored blob may be any schema version (older from a
// build before an upgrade, newer from another device); decodeStored() is
// the only way to turn it into Settings.
const settingsSyncItem = storage.defineItem<unknown>("sync:settings", { fallback: null });

const settingsLocalItem = storage.defineItem<unknown>("local:settings", { fallback: null });

/** Merged multi-provider voice cache (survives popup close; shared contexts). */
export const voicesSessionItem = storage.defineItem<z.infer<typeof NormalizedVoiceSchema>[]>(
  "session:voices",
  { fallback: [] },
);

/** What the user reads about a voice that failed, as the failure was
 *  described when it was recorded: the message in plain words, the one link
 *  that fixes it, and the raw text (secrets blanked) under detail. The
 *  background describes a failure once, for the notice it surfaces and for
 *  this cache alike; the picker shows the stored description as it is. */
const VoiceIssueSchema = ErrorPayloadSchema;

export type VoiceIssue = z.infer<typeof VoiceIssueSchema>;

/** Voices whose last synthesis failed, nested provider -> voice -> model,
 *  with the described failure as the leaf. LOCAL (not session) storage: scan
 *  results must survive extension reloads, and session storage is wiped on
 *  every reload, which in dev mode means every rebuild. Cleared per
 *  voice+engine on any successful synthesis/preview/scan, so a fixed account
 *  heals itself. */
export type VoiceIssues = Partial<Record<ProviderId, Record<string, Record<string, VoiceIssue>>>>;

// Typed `unknown`: the stored value is whatever a build wrote there;
// decodeVoiceIssues() is the only way to turn it into VoiceIssues.
export const voiceIssuesItem = storage.defineItem<unknown>("local:voiceIssues", {
  fallback: null,
});

/** Own-property read: voice and model ids are provider-supplied strings, so
 *  a name like "constructor" must read as absent, not as Object's method. */
function own<T>(record: Record<string, T> | undefined, key: string): T | undefined {
  return record !== undefined && Object.hasOwn(record, key) ? record[key] : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** The stored cache as VoiceIssues. A leaf that is not a described failure
 *  (a build that kept the provider's error text there, a corrupt value) reads
 *  as no issue, and a branch that is left empty disappears: the cache is
 *  rebuilt by use, so the mark returns with the next failed preview or scan
 *  and nothing is converted. Built from entries, never by indexed
 *  assignment: a voice named "__proto__" must become an own property. */
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

/** `issues` with one leaf set (`issue`) or removed (`null`), empty branches
 *  pruned. Returns the SAME object when nothing changes, so callers can skip
 *  the write. */
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

// The issue helpers do read-modify-write across contexts (popup previews,
// background playback, scans); they're serialized through the same
// cross-context write lock as settings so concurrent updates can't erase
// each other.

/** Apply a batch of issue updates in one write; a `null` issue clears. */
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

/** Field-by-field salvage core: only keys PRESENT in `raw` that validate
 *  (whole, or entry-by-entry for record fields) appear in `patch`;
 *  `dropped` lists present-but-unusable keys. `schemaVersion` is metadata
 *  the upgrade chain owns, never part of a patch. Record-shaped fields
 *  (perProvider, per-language voices) are salvaged ENTRY BY ENTRY:
 *  one malformed provider entry must not erase the others. A rescued-but-
 *  lossy record appears in BOTH patch and dropped. */
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
    // Record validation is per-entry, so a whole-field failure always means
    // at least one entry (or the whole scalar) was lost.
    dropped.push(key);
  }
  return { patch: patch as Partial<Settings>, dropped };
}

function salvageKnownFields(raw: unknown): Settings {
  return SettingsSchema.parse({ ...DEFAULT_SETTINGS, ...salvageSettingsPatch(raw).patch });
}

/**
 * Upgrade a blob of any older version to the current schema, then salvage it
 * FIELD BY FIELD: every key that still validates is kept, only broken keys
 * fall back to defaults. (A whole-object `partial()` parse would discard
 * everything when one field is bad, and the next write would then permanently
 * erase valid credentials.) Throws SettingsNewerError for a blob written by a
 * newer build; callers that must stay readable use decodeStored().
 */
export function salvageSettings(raw: unknown): Settings {
  const upgraded = upgradeSettingsBlob(raw);
  const parsed = SettingsSchema.safeParse(upgraded);
  if (parsed.success) return parsed.data;
  console.warn("Settings failed validation; salvaged valid fields");
  return salvageKnownFields(upgraded);
}

export interface SettingsRecord {
  settings: Settings;
  /** The blob's own schema version; above SETTINGS_VERSION means a newer
   *  build wrote it and this build must not write it back. */
  storedVersion: number;
}

/** The one decoder for a stored blob. A NEWER blob stays readable (its known
 *  fields are salvaged, so credentials and playback keep working). */
function decodeStored(raw: unknown): SettingsRecord {
  if (raw === null) return { settings: DEFAULT_SETTINGS, storedVersion: SETTINGS_VERSION };
  const storedVersion = peekSchemaVersion(raw);
  if (storedVersion > SETTINGS_VERSION) {
    return { settings: salvageKnownFields(raw), storedVersion };
  }
  return { settings: salvageSettings(raw), storedVersion };
}

/** Read from the active area. An OLDER blob is upgraded in memory and
 *  written back once (in the background, under the lock). */
export async function readSettingsRecord(): Promise<SettingsRecord> {
  const item = await activeItem();
  const record = decodeStored(await item.getValue());
  if (record.storedVersion < SETTINGS_VERSION) persistUpgradeOnce();
  return record;
}

export async function getSettings(): Promise<Settings> {
  return (await readSettingsRecord()).settings;
}

/** The active area's blob exactly as stored (null when empty), for handing
 *  to another install whose own decoder must see the real version. */
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

// Cross-context serialization goes through Web Locks: the popup and the
// service worker are separate JS contexts, so an in-memory chain cannot
// serialize their read-modify-write cycles. Web Locks are shared across the
// extension origin (Chrome 69+/Firefox 96+, below the manifest floors in
// wxt.config.ts) and their FIFO grant order also serializes within a context.
// One name per independent store, so unrelated writers never queue on each
// other.
export function withLock<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return navigator.locks.request(name, operation) as Promise<T>;
}

export function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  return withLock("cloud-speech-settings-write", operation);
}

/** Under the lock: the active item and its decoded content. Rejects with
 *  SettingsNewerError when a newer build wrote the blob, so no writer here
 *  can downgrade-clobber another device's settings. */
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

/**
 * Apply a patch computed from the FRESH current settings, inside the write
 * lock. Use this whenever the patch depends on prior state (nested credential
 * maps, favorites toggles, anything computed before an `await`).
 */
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

/** One-slot snapshot of the settings from before the last import. */
export interface SettingsBackup {
  /** ISO 8601 */
  savedAt: string;
  settings: Settings;
}

/** LOCAL on purpose: the snapshot is this device's undo, not shared state. */
export const importBackupItem = storage.defineItem<SettingsBackup | null>("local:importBackup", {
  fallback: null,
});

/**
 * Write settings computed from the FRESH current state, snapshotting the
 * pre-write settings to the one-slot import backup - all under the write
 * lock, so no other write can land between snapshot and replacement.
 */
export function setSettingsWithBackup(
  compute: (current: Settings) => Settings,
  now: Date,
): Promise<Settings> {
  return enqueueWrite(async () => {
    const { item, current } = await readForWrite();
    // Parse BEFORE touching the slot, and put the previous snapshot back if
    // the settings write fails (sync quota): a failed import must not cost
    // the user their existing restore point.
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

/** Restore the snapshot (upgraded, then salvaged), clear the slot; null when
 *  no snapshot. A slot whose settings salvage to NOTHING is treated as
 *  corrupt and cleared without writing: restoring pure defaults over real
 *  settings would be worse than refusing. A snapshot from a NEWER build
 *  rejects with SettingsNewerError and keeps the slot. */
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

/** Throw away the snapshot without restoring it: the slot holds plaintext
 *  credentials, and "wipe my keys off this machine" must have a way to
 *  include it. */
export function discardSettingsBackup(): Promise<void> {
  return enqueueWrite(() => importBackupItem.removeValue());
}

/** Watch the settings object in BOTH areas (the active one drives reads). */
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

/**
 * Flip the sync toggle: copy the settings object into the target area first,
 * then switch the flag, then clear the old area (never a destructive gap).
 * Runs inside the cross-context write lock like every other settings write.
 * Moving a blob between areas is lossless whatever its version, so the only
 * version guard is on the one path that OVERWRITES: enabling over a synced
 * copy a newer build wrote rejects with SettingsNewerError (adopting it is
 * the lossless way to enable).
 *
 * `adoptRemote` (enabling only): keep the EXISTING synced copy instead of
 * overwriting it with this device's settings; used when another browser
 * already synced a different configuration and the user chose theirs.
 */
export function setSyncEnabled(enabled: boolean, opts?: { adoptRemote?: boolean }): Promise<void> {
  return enqueueWrite(async () => {
    const current = await syncEnabledItem.getValue();
    if (current === enabled) return;

    if (enabled) {
      // The synced copy can vanish between the popup's conflict prompt and
      // this confirmation (another device turned sync off). Verify under the
      // lock; if it is gone, fall through to the normal copy-local path
      // instead of deleting the only remaining settings.
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

/** The synced settings object as another device left it (salvaged) with the
 *  version it was stored at, or null. Lets the popup detect a would-be
 *  overwrite BEFORE enabling sync: a newer stored version is always one,
 *  since the salvaged fields cannot show what the newer blob carries. */
export async function peekSyncedSettings(): Promise<SettingsRecord | null> {
  const raw = await settingsSyncItem.getValue();
  return raw === null ? null : decodeStored(raw);
}

/** Chrome's per-item quota for `storage.sync`. */
export const SYNC_QUOTA_BYTES_PER_ITEM = 8192;

/** Approximate Chrome's sync accounting (key length + serialized value, in
 *  UTF-8 BYTES - CJK settings are ~3x their UTF-16 length), with headroom.
 *  Used only to warn BEFORE enabling
 *  sync; the write itself stays the authority. */
export function estimateSyncSizeBytes(settings: Settings): number {
  return "settings".length + new TextEncoder().encode(JSON.stringify(settings)).length + 64;
}
