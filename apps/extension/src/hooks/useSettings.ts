import { useCallback, useEffect, useState } from "react";
import { type Report, reportMark, useReport } from "@/hooks/useReport";
import { useStorageValue } from "@/hooks/useStorageValue";
import { errorText } from "@/lib/errors/error-text";
import type { ErrorPayload } from "@/lib/messaging/protocol";
import { type Claim, NEVER_SUPERSEDED, Slot } from "@/lib/messaging/slot";
import {
  discardSettingsBackup,
  importBackupItem,
  restoreSettingsBackup,
  type Settings,
  type SettingsRecord,
  setSettingsWithBackup,
  syncEnabledItem,
  updateSettingsWith,
  watchSettingsRecord,
} from "@/lib/settings/storage";
import { i18n } from "@/lib/text/i18n-runtime";
import { installedStoreUrl } from "@/lib/text/listing";
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

/** A failure the operation has already described for the notice (a refusal at a boundary, a
 *  verdict carried back from the background); `useGuardedSubject` shows the payload as it is. */
export class DescribedFailure extends Error {
  constructor(readonly payload: ErrorPayload) {
    super(payload.message);
    this.name = "DescribedFailure";
  }
}

/** One subject (the sync switch, one provider's stored prefs, the voice selection) and one notice
 *  slot. The action claimed last owns the subject: its settlement clears or fills the slot, and an
 *  action claimed before it settles into nothing, result and failure alike. The operation receives
 *  the claim, which every settings write takes: the write refuses under the lock once a later claim
 *  aborted it, so a superseded action neither writes nor shows.
 *
 *  resolves, `touched`  -> the slot is cleared; the default counts every resolution as settled
 *  resolves, untouched  -> the slot stays (a Save & test the provider refused: nothing was stored)
 *  throws               -> the slot shows it: a DescribedFailure as is, anything else as a write error */
export function useGuardedSubject(): {
  failure: Report<ErrorPayload> | null;
  run: <T>(
    operation: (claim: Claim) => Promise<T>,
    touched?: (result: T) => boolean,
  ) => Promise<T | undefined>;
} {
  const [failure, setFailure] = useReport<ErrorPayload>();
  const [slot] = useState(() => new Slot());
  useEffect(() => () => slot.release(), [slot]);
  const run = useCallback(
    async <T>(
      operation: (claim: Claim) => Promise<T>,
      touched: (result: T) => boolean = () => true,
    ): Promise<T | undefined> => {
      const claim = slot.claim();
      let result: T;
      try {
        result = await operation(claim);
      } catch (error) {
        if (!claim.signal.aborted) {
          setFailure(error instanceof DescribedFailure ? error.payload : describeWriteError(error));
        }
        return undefined;
      }
      if (claim.signal.aborted) return undefined;
      if (touched(result)) setFailure(null);
      return result;
    },
    [slot, setFailure],
  );
  return { failure, run };
}

export function useSettings() {
  /** Two failures, one clearing rule each. A read failure (the read on mount included) describes
   *  stale displayed state, so only the next delivered record clears it: no click can. A rejected
   *  write is cleared only by a later write of this hook that began after the rejection, or by
   *  clearWriteError: another context's delivery, or a write already in flight when this one was
   *  rejected, says nothing about the refused change. A multi-step action (a read between two
   *  writes) is a subject of its own: `useGuardedSubject`. The writes below are one locked step
   *  each, so nothing can supersede them, and they carry the claim that says so; the mark rule
   *  stays because two controls' writes are not each other's successors. */
  const [readFailure, setReadFailure] = useReport<ErrorPayload>();
  const [writeRejection, setWriteRejection, clearWriteRejectionsThrough] =
    useReport<ErrorPayload>();
  // Not a useStorageValue source: the owner performs the read on mount, so a getValue here would be a second read path.
  const [record, setRecord] = useState<SettingsRecord | null>(null);
  useEffect(
    () =>
      watchSettingsRecord({
        onRecord: (next) => {
          setRecord(next);
          setReadFailure(null);
        },
        onReadFailure: (error) => setReadFailure(describeWriteError(error)),
      }),
    [setReadFailure],
  );
  const syncEnabled = useStorageValue(syncEnabledItem, true);
  const importBackup = useStorageValue(importBackupItem, null);

  const guard = useCallback(
    async <T>(operation: () => Promise<T>): Promise<T | undefined> => {
      const before = reportMark();
      try {
        const result = await operation();
        clearWriteRejectionsThrough(before);
        return result;
      } catch (error) {
        setWriteRejection(describeWriteError(error));
        return undefined;
      }
    },
    [setWriteRejection, clearWriteRejectionsThrough],
  );
  const clearWriteError = useCallback(() => setWriteRejection(null), [setWriteRejection]);
  const writeFailure =
    readFailure && writeRejection
      ? readFailure.key > writeRejection.key
        ? readFailure
        : writeRejection
      : (readFailure ?? writeRejection);

  const storedVersion = record?.storedVersion ?? SETTINGS_VERSION;
  return {
    settings: record?.settings ?? null,
    /** The schema version a NEWER build saved, or null when this build may write. Views lock their controls while set. */
    newerVersion: storedVersion > SETTINGS_VERSION ? storedVersion : null,
    /** The newer of the two failures, so a notice keyed on it reopens for each new one. */
    writeFailure,
    update: useCallback(
      (patch: Partial<Settings>) => guard(() => updateSettingsWith(NEVER_SUPERSEDED, () => patch)),
      [guard],
    ),
    /** The patch is computed from fresh state inside the write lock; required for nested
     *  structures (favorites, credential maps, voicesByLanguage). */
    updateWith: useCallback(
      (updater: (current: Settings) => Partial<Settings>) =>
        guard(() => updateSettingsWith(NEVER_SUPERSEDED, updater)),
      [guard],
    ),
    importBackup,
    /** Full replacement from fresh state, snapshotting the previous settings to the import backup first. */
    updateWithBackup: useCallback(
      (compute: (current: Settings) => Settings) =>
        guard(() => setSettingsWithBackup(NEVER_SUPERSEDED, compute, new Date())),
      [guard],
    ),
    restoreBackup: useCallback(() => guard(() => restoreSettingsBackup(NEVER_SUPERSEDED)), [guard]),
    discardBackup: useCallback(() => guard(() => discardSettingsBackup(NEVER_SUPERSEDED)), [guard]),
    /** Dismisses a rejected write's notice when the UI flow it belonged to is left. A read
     *  failure stays: the settings on screen are still stale. */
    clearWriteError,
    syncEnabled,
  };
}
