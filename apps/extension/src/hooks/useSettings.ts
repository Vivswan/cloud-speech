import { useCallback, useEffect, useState } from "react";
import { i18n } from "@/lib/i18n-runtime";
import {
  discardSettingsBackup,
  importBackupItem,
  readSettingsRecord,
  restoreSettingsBackup,
  SETTINGS_VERSION,
  type Settings,
  type SettingsBackup,
  type SettingsRecord,
  setSettingsWithBackup,
  setSyncEnabled as setSyncEnabledStorage,
  syncEnabledItem,
  updateSettings,
  updateSettingsWith,
  watchSettingsRecord,
} from "@/lib/storage";
import { SettingsNewerError } from "@/migrations";

/** Storage write failures were previously void-swallowed: on a full sync
 *  quota every control silently reverted. Map the raw error to actionable
 *  copy; the views render `writeError` inline. */
function classifyWriteError(error: unknown): string {
  if (error instanceof SettingsNewerError) return i18n.t("settings.storage_error_newer");
  const text = String(error);
  if (/QUOTA_BYTES|QUOTA_EXCEEDED|quota exceeded/i.test(text)) {
    return i18n.t("settings.storage_error_quota");
  }
  if (/MAX_WRITE_OPERATIONS|MAX_SUSTAINED_WRITE/i.test(text)) {
    return i18n.t("settings.storage_error_rate");
  }
  return i18n.t("settings.storage_error_generic");
}

/** Reactive settings backed by wxt/storage (sync or local per user toggle). */
export function useSettings() {
  const [record, setRecord] = useState<SettingsRecord | null>(null);
  const [syncEnabled, setSyncEnabledState] = useState(true);
  const [importBackup, setImportBackup] = useState<SettingsBackup | null>(null);
  const [writeError, setWriteError] = useState("");

  useEffect(() => {
    let mounted = true;
    readSettingsRecord().then((r) => mounted && setRecord(r));
    syncEnabledItem.getValue().then((v) => mounted && setSyncEnabledState(v));
    importBackupItem.getValue().then((v) => mounted && setImportBackup(v));

    const unwatchSettings = watchSettingsRecord((r) => mounted && setRecord(r));
    const unwatchSync = syncEnabledItem.watch((v) => mounted && setSyncEnabledState(v ?? true));
    const unwatchBackup = importBackupItem.watch((v) => mounted && setImportBackup(v));
    return () => {
      mounted = false;
      unwatchSettings();
      unwatchSync();
      unwatchBackup();
    };
  }, []);

  const guard = useCallback(async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
    try {
      const result = await operation();
      setWriteError("");
      return result;
    } catch (error) {
      setWriteError(classifyWriteError(error));
      return undefined;
    }
  }, []);

  const storedVersion = record?.storedVersion ?? SETTINGS_VERSION;
  return {
    settings: record?.settings ?? null,
    /** The schema version a NEWER build saved, or null when this build may
     *  write. Views render the note and lock their controls while set. */
    newerVersion: storedVersion > SETTINGS_VERSION ? storedVersion : null,
    /** Localized message when the last settings write failed; "" otherwise. */
    writeError,
    /** Flat patch of independent fields. */
    update: useCallback((patch: Partial<Settings>) => guard(() => updateSettings(patch)), [guard]),
    /** Patch computed from FRESH state inside the write lock; required for
     *  nested structures (favorites, credential maps, voicesByLanguage). */
    updateWith: useCallback(
      (updater: (current: Settings) => Partial<Settings>) =>
        guard(() => updateSettingsWith(updater)),
      [guard],
    ),
    /** One-slot snapshot of the settings from before the last import; reactive. */
    importBackup,
    /** Full replacement computed from FRESH state, snapshotting the previous
     *  settings to the import backup first. */
    updateWithBackup: useCallback(
      (compute: (current: Settings) => Settings) =>
        guard(() => setSettingsWithBackup(compute, new Date())),
      [guard],
    ),
    restoreBackup: useCallback(() => guard(() => restoreSettingsBackup()), [guard]),
    discardBackup: useCallback(() => guard(() => discardSettingsBackup()), [guard]),
    /** Reset a stale write error when the UI flow it belonged to is left. */
    clearWriteError: useCallback(() => setWriteError(""), []),
    syncEnabled,
    setSyncEnabled: useCallback(
      (enabled: boolean, opts?: { adoptRemote?: boolean }) =>
        guard(async () => {
          await setSyncEnabledStorage(enabled, opts);
          setRecord(await readSettingsRecord());
        }),
      [guard],
    ),
  };
}
