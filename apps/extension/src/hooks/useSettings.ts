import { useCallback, useMemo, useRef } from "react";
import { reportMark, useReport } from "@/hooks/useReport";
import { type StorageSource, useStorageValue } from "@/hooks/useStorageValue";
import { errorText } from "@/lib/error-text";
import { i18n } from "@/lib/i18n-runtime";
import { installedStoreUrl } from "@/lib/listing";
import type { ErrorPayload } from "@/lib/protocol";
import {
  discardSettingsBackup,
  importBackupItem,
  readSettingsRecord,
  restoreSettingsBackup,
  type Settings,
  type SettingsRecord,
  setSettingsWithBackup,
  setSyncEnabled as setSyncEnabledStorage,
  syncEnabledItem,
  updateSettings,
  updateSettingsWith,
  watchSettingsRecord,
} from "@/lib/storage";
import { SettingsNewerError } from "@/migrations";
import { SETTINGS_VERSION } from "@/migrations/ladder";

/** Shared by the refused write and the persistent lock note so both say the same thing, down to
 *  the detail: the text of the error the refused write throws. */
export function describeNewerVersion(storedVersion: number): ErrorPayload {
  const payload: ErrorPayload = {
    title: i18n.t("settings.storage_error_newer_title"),
    message: i18n.t("settings.storage_error_newer"),
    detail: String(new SettingsNewerError(storedVersion)),
  };
  const url = installedStoreUrl();
  if (url) payload.action = { label: i18n.t("settings.storage_error_newer_action"), url };
  return payload;
}

/** On a full sync quota every control would silently revert; the notice names the failure and the
 *  one thing to do about it. */
export function describeWriteError(error: unknown): ErrorPayload {
  if (error instanceof SettingsNewerError) return describeNewerVersion(error.storedVersion);
  const detail = errorText(error);
  const title = i18n.t("settings.storage_error_title");
  if (/QUOTA_BYTES|QUOTA_EXCEEDED|quota exceeded/i.test(detail)) {
    return { title, message: i18n.t("settings.storage_error_quota"), detail };
  }
  if (/MAX_WRITE_OPERATIONS|MAX_SUSTAINED_WRITE/i.test(detail)) {
    return { title, message: i18n.t("settings.storage_error_rate"), detail };
  }
  return { title, message: i18n.t("settings.storage_error_generic"), detail };
}

export function useSettings() {
  const [writeFailure, setWriteFailure, clearWriteFailuresThrough] = useReport<ErrorPayload>();
  /** A failure notice (a refused write, a record that could not be read back, whichever context
   *  caused it) stands until the owner delivers a record whose storage change began after the
   *  notice. So a write that changes nothing clears nothing, and a change already in flight when a
   *  write fails cannot clear that failure. The latest change's mark is every delivery's mark
   *  because the owner delivers only the newest change's read-back (storage.ts, watchSettingsRecord). */
  const latestChange = useRef(0);
  const recordSource = useMemo<StorageSource<SettingsRecord>>(
    () => ({
      getValue: readSettingsRecord,
      watch: (callback) =>
        watchSettingsRecord({
          onChange: () => {
            latestChange.current = reportMark();
          },
          onRecord: (record) => {
            callback(record);
            clearWriteFailuresThrough(latestChange.current);
          },
          onReadFailure: (error) => setWriteFailure(describeWriteError(error)),
        }),
    }),
    [setWriteFailure, clearWriteFailuresThrough],
  );
  const record = useStorageValue(recordSource, null);
  const syncEnabled = useStorageValue(syncEnabledItem, true);
  const importBackup = useStorageValue(importBackupItem, null);

  const guard = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
      try {
        return await operation();
      } catch (error) {
        setWriteFailure(describeWriteError(error));
        return undefined;
      }
    },
    [setWriteFailure],
  );

  const storedVersion = record?.storedVersion ?? SETTINGS_VERSION;
  return {
    settings: record?.settings ?? null,
    /** The schema version a NEWER build saved, or null when this build may write. Views lock their controls while set. */
    newerVersion: storedVersion > SETTINGS_VERSION ? storedVersion : null,
    writeFailure,
    update: useCallback((patch: Partial<Settings>) => guard(() => updateSettings(patch)), [guard]),
    /** The patch is computed from fresh state inside the write lock; required for nested
     *  structures (favorites, credential maps, voicesByLanguage). */
    updateWith: useCallback(
      (updater: (current: Settings) => Partial<Settings>) =>
        guard(() => updateSettingsWith(updater)),
      [guard],
    ),
    importBackup,
    /** Full replacement from fresh state, snapshotting the previous settings to the import backup first. */
    updateWithBackup: useCallback(
      (compute: (current: Settings) => Settings) =>
        guard(() => setSettingsWithBackup(compute, new Date())),
      [guard],
    ),
    restoreBackup: useCallback(() => guard(() => restoreSettingsBackup()), [guard]),
    discardBackup: useCallback(() => guard(() => discardSettingsBackup()), [guard]),
    /** Reset a stale write error when the UI flow it belonged to is left. */
    clearWriteError: useCallback(() => setWriteFailure(null), [setWriteFailure]),
    syncEnabled,
    setSyncEnabled: useCallback(
      (enabled: boolean, opts?: { adoptRemote?: boolean }) =>
        guard(() => setSyncEnabledStorage(enabled, opts)),
      [guard],
    ),
  };
}
