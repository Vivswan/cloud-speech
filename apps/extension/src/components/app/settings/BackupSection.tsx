import { useEffect, useRef, useState } from "react";
import type { Browser } from "wxt/browser";
import { browser } from "#imports";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { useSettings } from "@/hooks/useSettings";
import { i18n, tDynamic } from "@/lib/i18n-runtime";
import { sendToBackground } from "@/lib/messages";
import {
  buildExport,
  exportFilename,
  type ImportErrorCode,
  MAX_IMPORT_FILE_BYTES,
  mergeSettings,
  type ParseImportResult,
  parseImport,
  serializeExport,
} from "@/lib/settings-transfer";
import { estimateSyncSizeBytes, SYNC_QUOTA_BYTES_PER_ITEM } from "@/lib/storage";
import { getProvider } from "@/providers";

type PendingImport = Extract<ParseImportResult, { ok: true }>;

function importErrorMessage(code: ImportErrorCode): string {
  switch (code) {
    case "not-json":
      return i18n.t("settings.backup_import_not_json");
    case "wrong-app":
      return i18n.t("settings.backup_import_wrong_app");
    case "future-version":
      return i18n.t("settings.backup_import_future_version");
    case "nothing-salvageable":
      return i18n.t("settings.backup_import_nothing");
  }
}

/** Export/import the whole settings object as a JSON file, plus a one-slot
 *  restore of the settings as they were before the last import. All decision
 *  logic lives in lib/settings-transfer. */
export function BackupSection() {
  const {
    settings,
    updateWithBackup,
    restoreBackup,
    discardBackup,
    importBackup,
    syncEnabled,
    writeError,
    clearWriteError,
  } = useSettings();
  const fileInput = useRef<HTMLInputElement>(null);
  const panel = useRef<HTMLFieldSetElement>(null);
  // Orders overlapping file reads: only the LATEST selection may open or
  // replace the confirm panel (a slow read of file A must not clobber B).
  const readGeneration = useRef(0);
  const [pending, setPending] = useState<PendingImport | null>(null);
  // Synchronous re-entry guard for every mutating handler: a second
  // Replace/Merge activation would snapshot the ALREADY-imported settings,
  // destroying the pre-import restore point, and async state updates land
  // too late to block it. The state below only drives spinners/disabled.
  const mutationInFlight = useRef(false);
  const [confirming, setConfirming] = useState<"replace" | "merge" | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const busy = confirming !== null || restoring;

  // Move focus to the confirm panel whenever it (re)opens: it appears below
  // the trigger, silently to screen readers, and a second file selection
  // swaps its content in place.
  useEffect(() => {
    if (pending) panel.current?.focus();
  }, [pending]);

  if (!settings) return null;

  async function handleExport() {
    setError("");
    setSuccess("");
    clearWriteError();
    if (!settings) return;
    const now = new Date();
    // Blob URL, not a data: URI: DownloadItem.url is recorded in download
    // history, which would persist the API keys beyond the file itself.
    // No saveAs: a native Save As dialog can steal focus and close the
    // popup, and a blob: URL dies with the popup document.
    const url = URL.createObjectURL(
      new Blob([serializeExport(buildExport(settings, now))], { type: "application/json" }),
    );
    try {
      const downloadId = await browser.downloads.download({
        url,
        filename: exportFilename(now),
      });
      // Revoke only once the download settles, not when download() resolves;
      // if the popup closes first, document teardown revokes the URL anyway.
      const onChanged = (delta: Browser.downloads.DownloadDelta) => {
        if (delta.id !== downloadId) return;
        const state = delta.state?.current;
        if (state !== "complete" && state !== "interrupted") return;
        browser.downloads.onChanged.removeListener(onChanged);
        URL.revokeObjectURL(url);
      };
      browser.downloads.onChanged.addListener(onChanged);
    } catch {
      URL.revokeObjectURL(url);
      setError(i18n.t("settings.backup_export_failed"));
    }
  }

  async function handleFileSelected(file: File) {
    const generation = ++readGeneration.current;
    setPending(null);
    if (file.size > MAX_IMPORT_FILE_BYTES) {
      setError(i18n.t("settings.backup_file_too_large"));
      return;
    }
    let text: string;
    try {
      text = await file.text();
    } catch {
      if (generation === readGeneration.current) {
        setError(i18n.t("settings.backup_read_failed"));
      }
      return;
    }
    if (generation !== readGeneration.current) return;
    const parsed = parseImport(text);
    if (!parsed.ok) {
      setError(importErrorMessage(parsed.error));
      return;
    }
    setPending(parsed);
  }

  async function handleConfirm(parsed: PendingImport, mode: "replace" | "merge") {
    if (!settings || mutationInFlight.current) return;
    setError("");
    // Advisory pre-check only; the write itself stays the authority.
    if (syncEnabled) {
      const candidate =
        mode === "replace" ? parsed.settings : mergeSettings(settings, parsed.patch);
      if (estimateSyncSizeBytes(candidate) > SYNC_QUOTA_BYTES_PER_ITEM) {
        setError(i18n.t("settings.backup_import_too_large"));
        return;
      }
    }
    mutationInFlight.current = true;
    setConfirming(mode);
    try {
      const written = await updateWithBackup((current) =>
        mode === "replace" ? parsed.settings : mergeSettings(current, parsed.patch),
      );
      // Failed write: keep the panel open; writeError above explains it.
      if (!written) return;
      // Fire-and-forget: the background refetches voices for the imported
      // credentials and reconciles selections.
      sendToBackground("fetchVoices").catch(() => {});
      setPending(null);
      // An imported uiLanguage change remounts the tree (App.tsx) and loses this line; same accepted tradeoff as credential drafts.
      setSuccess(i18n.t("settings.backup_import_success"));
    } finally {
      mutationInFlight.current = false;
      setConfirming(null);
    }
  }

  async function handleRestore() {
    if (mutationInFlight.current) return;
    setError("");
    setSuccess("");
    mutationInFlight.current = true;
    setRestoring(true);
    try {
      const restored = await restoreBackup();
      if (!restored) return;
      sendToBackground("fetchVoices").catch(() => {});
      // An open confirm panel must not survive the restore and offer to
      // import over the just-restored settings.
      setPending(null);
      setSuccess(i18n.t("settings.backup_restore_success"));
    } finally {
      mutationInFlight.current = false;
      setRestoring(false);
    }
  }

  async function handleDiscard() {
    if (mutationInFlight.current) return;
    setError("");
    setSuccess("");
    mutationInFlight.current = true;
    try {
      // No success line: the row disappears reactively via importBackup.
      await discardBackup();
    } finally {
      mutationInFlight.current = false;
    }
  }

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
                // Clear stale state: a canceled OS picker fires no change
                // event, so an old outcome line or a previous file's confirm
                // panel would otherwise survive the round-trip. Bumping the
                // generation also invalidates any still-running file read; a
                // slow read of the PREVIOUS file must not reopen the panel
                // after the user cancels the new picker.
                readGeneration.current++;
                setError("");
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
                setError("");
                setSuccess("");
                clearWriteError();
              }}
            >
              {i18n.t("common.cancel")}
            </Button>
          </div>
        </fieldset>
      )}
      {(error || writeError) && (
        <div role="alert" className="mt-2 text-xxs text-danger">
          {error || writeError}
        </div>
      )}
      {success && (
        <div role="status" className="mt-2 text-xxs font-semibold text-success">
          {success}
        </div>
      )}
    </div>
  );
}
