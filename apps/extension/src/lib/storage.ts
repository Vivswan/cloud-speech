import { z } from "zod";
import { storage } from "#imports";
import { type NormalizedVoiceSchema, PROVIDER_IDS, type ProviderId } from "@/providers/types";

// ---------------------------------------------------------------------------
// Settings schema — the single persisted settings object. Validated with Zod
// on every read so a corrupt blob degrades to defaults instead of crashing.
// ---------------------------------------------------------------------------

export const SelectedVoiceSchema = z.object({
  providerId: z.enum(PROVIDER_IDS),
  voiceId: z.string().min(1),
});

export type SelectedVoice = z.infer<typeof SelectedVoiceSchema>;

export const SettingsSchema = z.object({
  credentials: z.partialRecord(z.enum(PROVIDER_IDS), z.record(z.string(), z.string())).default({}),
  credentialsValid: z.partialRecord(z.enum(PROVIDER_IDS), z.boolean()).default({}),
  enabledProviders: z.partialRecord(z.enum(PROVIDER_IDS), z.boolean()).default({}),
  /** Source of truth for synthesis. Null until the user picks a voice. */
  selectedVoice: SelectedVoiceSchema.nullable().default(null),
  /** Last-used voice per language (UX memory for the language filter). */
  voicesByLanguage: z.record(z.string(), SelectedVoiceSchema).default({}),
  /** Composite `providerId:voiceId` keys. */
  favorites: z.array(z.string()).default([]),
  model: z.string().default("neural"),
  style: z.string().optional(),
  speed: z.number().default(1),
  pitch: z.number().default(0),
  volumeGainDb: z.number().default(0),
  readAloudEncoding: z.string().default("OGG_OPUS"),
  downloadEncoding: z.string().default("MP3_64_KBPS"),
  language: z.string().default("en-US"),
});

export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});

// ---------------------------------------------------------------------------
// Storage items. The settings object lives in `sync` OR `local`, chosen by a
// user toggle that itself always lives in `local` (it must not sync).
// ---------------------------------------------------------------------------

export const SETTINGS_VERSION = 1;

export const syncEnabledItem = storage.defineItem<boolean>("local:syncEnabled", {
  fallback: true,
});

const settingsSyncItem = storage.defineItem<Settings | null>("sync:settings", {
  fallback: null,
  version: SETTINGS_VERSION,
});

const settingsLocalItem = storage.defineItem<Settings | null>("local:settings", {
  fallback: null,
  version: SETTINGS_VERSION,
});

/** Merged multi-provider voice cache (survives popup close; shared contexts). */
export const voicesSessionItem = storage.defineItem<z.infer<typeof NormalizedVoiceSchema>[]>(
  "session:voices",
  { fallback: [] },
);

/** Voices whose last synthesis failed, keyed `providerId:voiceId:model` (one
 *  mark per engine — a dual-engine voice can work on neural and fail on
 *  standard), with the provider's error message as the value. LOCAL (not
 *  session) storage: scan results must survive extension reloads — session
 *  storage is wiped on every reload, which in dev mode means every rebuild.
 *  Cleared per voice+engine on any successful synthesis/preview/scan, so a
 *  fixed account heals itself. */
export const voiceIssuesItem = storage.defineItem<Record<string, string>>("local:voiceIssues", {
  fallback: {},
});

/** Compose a voice-issue key. Voice ids may contain colons; the model is the
 *  LAST segment, the provider the first. */
export function voiceIssueKey(providerId: string, voiceId: string, model: string): string {
  return `${providerId}:${voiceId}:${model}`;
}

// The issue helpers do read-modify-write across contexts (popup previews,
// background playback, scans) — serialized through the same cross-context
// write lock as settings so concurrent updates can't erase each other.
export function recordVoiceIssue(key: string, reason: string): Promise<void> {
  return enqueueWrite(async () => {
    const issues = await voiceIssuesItem.getValue();
    await voiceIssuesItem.setValue({ ...issues, [key]: reason });
  });
}

export function clearVoiceIssue(key: string): Promise<void> {
  return enqueueWrite(async () => {
    const issues = await voiceIssuesItem.getValue();
    if (!(key in issues)) return;
    const { [key]: _removed, ...rest } = issues;
    await voiceIssuesItem.setValue(rest);
  });
}

/** Merge a batch of issue updates in one write; `null` clears the key. */
export function mergeVoiceIssues(batch: Record<string, string | null>): Promise<void> {
  return enqueueWrite(async () => {
    const issues = await voiceIssuesItem.getValue();
    const next: Record<string, string> = { ...issues };
    for (const [key, reason] of Object.entries(batch)) {
      if (reason === null) delete next[key];
      else next[key] = reason;
    }
    await voiceIssuesItem.setValue(next);
  });
}

/** Parked playback snapshot — lets a read survive the offscreen document's
 *  ~30s idle auto-close AND the service worker recycle that follows: a fresh
 *  worker restores this and can resume/scrub without re-synthesizing.
 *  Session-scoped on purpose: parked audio should not outlive the browser. */
export interface ParkedTransport {
  audioUri: string;
  rate: number;
  text: string;
  currentTime: number;
  duration: number;
}

export const parkedTransportItem = storage.defineItem<ParkedTransport | null>(
  "session:parkedTransport",
  { fallback: null },
);

async function activeItem() {
  const syncEnabled = await syncEnabledItem.getValue();
  return syncEnabled ? settingsSyncItem : settingsLocalItem;
}

/**
 * Salvage a possibly-corrupt settings blob FIELD BY FIELD: every key that
 * still validates is kept, only broken keys fall back to defaults. (A whole-
 * object `partial()` parse would discard everything when one field is bad —
 * and the next write would then permanently erase valid credentials.)
 * Record-shaped fields (credentials, flags, per-language voices) are salvaged
 * ENTRY BY ENTRY — one malformed provider entry must not erase the others.
 */
export function salvageSettings(raw: unknown): Settings {
  const parsed = SettingsSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const result: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (raw && typeof raw === "object") {
    for (const [key, fieldSchema] of Object.entries(SettingsSchema.shape)) {
      const value = (raw as Record<string, unknown>)[key];
      if (value === undefined) continue;
      const field = fieldSchema.safeParse(value);
      if (field.success) {
        result[key] = field.data;
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        const entries: Record<string, unknown> = {};
        for (const [entryKey, entryValue] of Object.entries(value)) {
          const single = fieldSchema.safeParse({ [entryKey]: entryValue });
          if (single.success) Object.assign(entries, single.data);
        }
        const rescued = fieldSchema.safeParse(entries);
        if (rescued.success && Object.keys(entries).length > 0) result[key] = rescued.data;
      }
    }
  }
  console.warn("Settings failed validation; salvaged valid fields");
  return SettingsSchema.parse(result);
}

/** Read settings from the active area; corrupt/missing data → salvaged. */
export async function getSettings(): Promise<Settings> {
  const item = await activeItem();
  const raw = await item.getValue();
  if (raw === null) return DEFAULT_SETTINGS;
  return salvageSettings(raw);
}

// All writes are funnelled through a CROSS-CONTEXT lock: the popup and the
// service worker are separate JS contexts, so an in-memory promise chain alone
// cannot serialize their read-modify-write cycles. The Web Locks API is shared
// across all contexts of the extension origin (Chrome 69+; we require 116).
// The local chain remains as ordering within a context and as a fallback for
// environments without navigator.locks (e.g. some test setups).
let writeChain: Promise<unknown> = Promise.resolve();

function enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
  const locked = async (): Promise<T> =>
    typeof navigator !== "undefined" && navigator.locks
      ? ((await navigator.locks.request("cloud-speech-settings-write", operation)) as T)
      : operation();
  const next = writeChain.then(locked, locked);
  writeChain = next.catch(() => {});
  return next;
}

export function setSettings(settings: Settings): Promise<void> {
  return enqueueWrite(async () => {
    const item = await activeItem();
    await item.setValue(SettingsSchema.parse(settings));
  });
}

/**
 * Migration-only: run the whole read → check → build → write sequence inside
 * the settings write lock, so a popup write can't land between the snapshot
 * and the migration's write (which would then overwrite it with stale data).
 * The callback gets an UNLOCKED writer — the lock is not reentrant, so it
 * must never call setSettings/updateSettings itself.
 */
export function migrateExclusive(
  operation: (write: (settings: Settings) => Promise<void>) => Promise<boolean>,
): Promise<boolean> {
  return enqueueWrite(() =>
    operation(async (settings) => {
      const item = await activeItem();
      await item.setValue(SettingsSchema.parse(settings));
    }),
  );
}

export function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  return updateSettingsWith(() => patch);
}

/**
 * Apply a patch computed from the FRESH current settings, inside the write
 * lock — use this whenever the patch depends on prior state (nested credential
 * maps, favorites toggles, anything computed before an `await`).
 */
export function updateSettingsWith(
  updater: (current: Settings) => Partial<Settings>,
): Promise<Settings> {
  return enqueueWrite(async () => {
    const item = await activeItem();
    const raw = await item.getValue();
    const current = raw === null ? DEFAULT_SETTINGS : salvageSettings(raw);
    const next = SettingsSchema.parse({ ...current, ...updater(current) });
    await item.setValue(next);
    return next;
  });
}

/** Watch the settings object in BOTH areas (the active one drives reads). */
export function watchSettings(callback: (settings: Settings) => void): () => void {
  const emit = async () => callback(await getSettings());
  const unwatchSync = settingsSyncItem.watch(emit);
  const unwatchLocal = settingsLocalItem.watch(emit);
  return () => {
    unwatchSync();
    unwatchLocal();
  };
}

/**
 * Flip the sync toggle: copy the settings object into the target area first,
 * then switch the flag, then clear the old area — never a destructive gap.
 * Runs inside the cross-context write lock like every other settings write.
 */
export function setSyncEnabled(enabled: boolean): Promise<void> {
  return enqueueWrite(async () => {
    const current = await syncEnabledItem.getValue();
    if (current === enabled) return;

    const from = current ? settingsSyncItem : settingsLocalItem;
    const to = enabled ? settingsSyncItem : settingsLocalItem;

    const value = await from.getValue();
    if (value !== null) await to.setValue(value);
    await syncEnabledItem.setValue(enabled);
    if (value !== null) await from.removeValue();
  });
}

/** Update credentials for one provider; invalidates only that provider. */
export function setProviderCredentials(
  providerId: ProviderId,
  credentials: Record<string, string>,
): Promise<Settings> {
  return updateSettingsWith((current) => ({
    credentials: { ...current.credentials, [providerId]: credentials },
    credentialsValid: { ...current.credentialsValid, [providerId]: false },
  }));
}
