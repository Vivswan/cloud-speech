import { useCallback, useEffect, useState } from "react";
import { i18n } from "@/lib/i18n-runtime";
import {
  discardSettingsBackup,
  getSettings,
  importBackupItem,
  restoreSettingsBackup,
  type Settings,
  type SettingsBackup,
  setSettingsWithBackup,
  setSyncEnabled as setSyncEnabledStorage,
  syncEnabledItem,
  updateSettings,
  updateSettingsWith,
  watchSettings,
} from "@/lib/storage";

/** Storage write failures were previously void-swallowed: on a full sync
 *  quota every control silently reverted. Map the raw error to actionable
 *  copy; the views render `writeError` inline. */
function classifyWriteError(error: unknown): string {
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
  const [settings, setSettings] = useState<Settings | null>(null);
  const [syncEnabled, setSyncEnabledState] = useState(true);
  const [importBackup, setImportBackup] = useState<SettingsBackup | null>(null);
  const [writeError, setWriteError] = useState("");

  useEffect(() => {
    let mounted = true;
    getSettings().then((s) => mounted && setSettings(s));
    syncEnabledItem.getValue().then((v) => mounted && setSyncEnabledState(v));
    importBackupItem.getValue().then((v) => mounted && setImportBackup(v));

    const unwatchSettings = watchSettings((s) => mounted && setSettings(s));
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

  return {
    ready: settings !== null,
    settings,
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
          setSettings(await getSettings());
        }),
      [guard],
    ),
  };
}
