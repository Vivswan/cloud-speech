import { useEffect, useRef, useState } from "react";
import type { Browser } from "wxt/browser";
import { browser } from "#imports";
import { ErrorNotice } from "@/components/app/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { useReport } from "@/hooks/useReport";
import { useSettings } from "@/hooks/useSettings";
import { errorText } from "@/lib/error-text";
import { i18n, tDynamic } from "@/lib/i18n-runtime";
import { type ErrorPayload, sendToBackground } from "@/lib/protocol";
import {
  buildExport,
  describeImportFailure,
  exportFilename,
  MAX_IMPORT_FILE_BYTES,
  mergeSettings,
  type ParseImportResult,
  parseImport,
  serializeExport,
} from "@/lib/settings-transfer";
import { estimateSyncSizeBytes, SYNC_QUOTA_BYTES_PER_ITEM } from "@/lib/storage";
import { getProvider } from "@/providers";

type PendingImport = Extract<ParseImportResult, { ok: true }>;

function importFailure(message: string, detail: string): ErrorPayload {
  return { title: i18n.t("settings.backup_import_failed_title"), message, detail };
}

/** All decision logic lives in lib/settings-transfer. */
export function BackupSection() {
  const {
    settings,
    updateWithBackup,
    restoreBackup,
    discardBackup,
    importBackup,
    syncEnabled,
    writeFailure,
    clearWriteError,
  } = useSettings();
  const fileInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLFieldSetElement>(null);
  // Only the latest file selection may open or replace the confirm panel: a slow read of file A
  // must not clobber B.
  const readGeneration = useRef(0);
  const [pending, setPending] = useState<PendingImport | null>(null);
  // A ref, not state: a second Replace/Merge activation would snapshot the already-imported
  // settings and destroy the pre-import restore point, and async state updates land too late to block it.
  const mutationInFlight = useRef(false);
  const [confirming, setConfirming] = useState<"replace" | "merge" | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useReport<ErrorPayload>();
  const [success, setSuccess] = useState("");
  const busy = confirming !== null || restoring;

  // The confirm panel appears below the trigger, silently to screen readers, and a second file
  // selection swaps its content in place, so focus moves to it whenever it (re)opens.
  useEffect(() => {
    if (pending) panel.current?.focus();
  }, [pending]);

  if (!settings) return null;

  async function handleExport() {
    setError(null);
    setSuccess("");
    clearWriteError();
    if (!settings) return;
    const now = new Date();
    // A blob: URL, not data:, because DownloadItem.url is recorded in download history and would
    // persist the API keys beyond the file. No saveAs: the native dialog can steal focus and
    // close the popup, and a blob: URL dies with the popup document.
    const url = URL.createObjectURL(
      new Blob([serializeExport(buildExport(settings, now))], { type: "application/json" }),
    );
    try {
      const downloadId = await browser.downloads.download({
        url,
        filename: exportFilename(now),
      });
      // Revoked once the download settles, not when download() resolves; if the popup closes
      // first, document teardown revokes the URL anyway.
      const onChanged = (delta: Browser.downloads.DownloadDelta) => {
        if (delta.id !== downloadId) return;
        const state = delta.state?.current;
        if (state !== "complete" && state !== "interrupted") return;
        browser.downloads.onChanged.removeListener(onChanged);
        URL.revokeObjectURL(url);
      };
      browser.downloads.onChanged.addListener(onChanged);
    } catch (error) {
      URL.revokeObjectURL(url);
      setError({
        title: i18n.t("settings.backup_export_failed_title"),
        message: i18n.t("settings.backup_export_failed"),
        detail: errorText(error),
      });
    }
  }

  async function handleFileSelected(file: File) {
    const generation = ++readGeneration.current;
    setPending(null);
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setError(
        importFailure(
          i18n.t("settings.backup_file_too_large"),
          `ImportFileTooLarge: ${file.size} bytes > MAX_IMPORT_FILE_BYTES ${MAX_IMPORT_FILE_BYTES}`,
        ),
      );
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch (error) {
      if (generation === readGeneration.current) {
        setError(importFailure(i18n.t("settings.backup_read_failed"), errorText(error)));
      }
      return;
    }
    if (generation !== readGeneration.current) return;
    const parsed = parseImport(text);
    if (!parsed.ok) {
      setError(describeImportFailure(parsed));
      return;
    }
    setPending(parsed);
  }

  async function handleConfirm(parsed: PendingImport, mode: "replace" | "merge") {
    if (!settings || mutationInFlight.current) return;
    setError(null);
    // Advisory pre-check only; the write itself stays the authority.
    if (syncEnabled) {
      const candidate =
        mode === "replace" ? parsed.settings : mergeSettings(settings, parsed.patch);
      const size = estimateSyncSizeBytes(candidate);
      if (size > SYNC_QUOTA_BYTES_PER_ITEM) {
        setError(
          importFailure(
            i18n.t("settings.backup_import_too_large"),
            `ImportTooLargeToSync: ${mode} estimate ${size} bytes > QUOTA_BYTES_PER_ITEM ${SYNC_QUOTA_BYTES_PER_ITEM}`,
          ),
        );
        return;
      }
    }
    mutationInFlight.current = true;
    setConfirming(mode);
    try {
      const written = await updateWithBackup((current) =>
        mode === "replace" ? parsed.settings : mergeSettings(current, parsed.patch),
      );
      // Failed write: the panel stays open and writeFailure explains it.
      if (!written) return;
      sendToBackground("fetchVoices").catch(() => {});
      setPending(null);
      // An imported uiLanguage change remounts the tree (App.tsx) and loses this line; accepted.
      setSuccess(i18n.t("settings.backup_import_success"));
    } finally {
      mutationInFlight.current = false;
      setConfirming(null);
    }
  }

  async function handleRestore() {
    if (mutationInFlight.current) return;
    setError(null);
    setSuccess("");
    mutationInFlight.current = true;
    setRestoring(true);
    try {
      const restored = await restoreBackup();
      if (!restored) return;
      sendToBackground("fetchVoices").catch(() => {});
      // An open confirm panel must not survive the restore and offer to import over the
      // just-restored settings.
      setPending(null);
      setSuccess(i18n.t("settings.backup_restore_success"));
    } finally {
      mutationInFlight.current = false;
      setRestoring(false);
    }
  }

  async function handleDiscard() {
    if (mutationInFlight.current) return;
    setError(null);
    setSuccess("");
    mutationInFlight.current = true;
    try {
      // No success line: the row disappears reactively via importBackup.
      await discardBackup();
    } finally {
      mutationInFlight.current = false;
    }
  }

  // This section's own failure first: a refused write explains the panel that stays open.
  const shownFailure = error ?? writeFailure;
  return (
    <div>
      <SectionTitle>{i18n.t("settings.backup_title")}</SectionTitle>
      <Card className="flex flex-col gap-2.5">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold text-body">{i18n.t("settings.backup_label")}</div>
            <div className="text-xxs text-muted">{i18n.t("settings.backup_hint")}</div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Button onClick={() => void handleExport()}>{i18n.t("settings.backup_export")}</Button>
            <Button
              onClick={() => {
                // A canceled OS picker fires no change event, so stale outcome lines and the previous
                // confirm panel are cleared now. The generation bump also discards the result of a
                // still-running read of the previous file, which must not reopen the panel after the user cancels.
                readGeneration.current++;
                setError(null);
                setSuccess("");
                clearWriteError();
                setPending(null);
                fileInput.current?.click();
              }}
            >
              {i18n.t("settings.backup_import")}
            </Button>
          </div>
        </div>
        {importBackup && (
          <div className="flex items-center gap-3 border-t border-edge pt-2.5">
            <div className="min-w-0 flex-1 text-xxs text-muted">
              {i18n.t("settings.backup_restore_hint", [
                new Date(importBackup.savedAt).toLocaleDateString(),
              ])}
            </div>
            <div className="flex shrink-0 gap-2">
              <Button submitting={restoring} disabled={busy} onClick={() => void handleRestore()}>
                {i18n.t("settings.backup_restore")}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => void handleDiscard()}>
                {i18n.t("settings.backup_discard")}
              </Button>
            </div>
          </div>
        )}
      </Card>
      <input
        ref={fileInput}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          // Reset so re-selecting the same file fires change again.
          event.target.value = "";
          if (file) void handleFileSelected(file);
        }}
      />
      {pending && (
        <fieldset
          ref={panel}
          tabIndex={-1}
          aria-labelledby="backup-import-prompt"
          className="mt-2 rounded border border-note-edge bg-note p-2.5 text-xxs text-note-text"
        >
          <div id="backup-import-prompt" className="font-semibold">
            {i18n.t("settings.backup_import_prompt")}
          </div>
          {pending.exportedAt !== null && (
            <div>
              {i18n.t("settings.backup_import_exported_at", [
                new Date(pending.exportedAt).toLocaleDateString(),
              ])}
            </div>
          )}
          <div>
            {pending.providersWithCredentials.length > 0
              ? i18n.t("settings.backup_import_providers", [
                  pending.providersWithCredentials
                    .map((id) => tDynamic(getProvider(id).labelKey))
                    .join(", "),
                ])
              : i18n.t("settings.backup_import_no_credentials")}
          </div>
          {pending.droppedFields.length > 0 && (
            <div>{i18n.t("settings.backup_import_dropped")}</div>
          )}
          <div>
            {i18n.t("settings.backup_import_keeps_backup")}
            {importBackup &&
              ` ${i18n.t("settings.backup_import_replaces_backup", [
                new Date(importBackup.savedAt).toLocaleDateString(),
              ])}`}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            <Button
              submitting={confirming === "replace"}
              disabled={busy}
              onClick={() => void handleConfirm(pending, "replace")}
            >
              {i18n.t("settings.backup_replace")}
            </Button>
            <Button
              submitting={confirming === "merge"}
              disabled={busy}
              onClick={() => void handleConfirm(pending, "merge")}
            >
              {i18n.t("settings.backup_merge")}
            </Button>
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => {
                setPending(null);
                setError(null);
                setSuccess("");
                clearWriteError();
              }}
            >
              {i18n.t("common.cancel")}
            </Button>
          </div>
        </fieldset>
      )}
      {shownFailure && (
        <ErrorNotice error={shownFailure.value} reportKey={shownFailure.key} className="mt-2" />
      )}
      {success && (
        <div role="status" className="mt-2 text-xxs font-semibold text-success">
          {success}
        </div>
      )}
    </div>
  );
}
