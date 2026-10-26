import { type ChangeEvent, type Ref, useEffect, useRef, useState } from "react";
import type { Browser } from "wxt/browser";
import { browser } from "#imports";
import { ErrorNotice } from "@/components/app/ErrorNotice";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { type Report, useReport } from "@/hooks/useReport";
import { useSettings } from "@/hooks/useSettings";
import { errorText } from "@/lib/errors/error-text";
import { type ErrorPayload, sendToBackground } from "@/lib/messaging/protocol";
import {
  buildExport,
  describeImportFailure,
  exportFilename,
  MAX_IMPORT_FILE_BYTES,
  mergeSettings,
  type ParseImportResult,
  parseImport,
  serializeExport,
} from "@/lib/settings/settings-transfer";
import {
  estimateSyncSizeBytes,
  type Settings,
  SYNC_QUOTA_BYTES_PER_ITEM,
} from "@/lib/settings/storage";
import { i18n, tDynamic } from "@/lib/text/i18n-runtime";
import { getProvider } from "@/providers";
import type { ProviderId } from "@/providers/types";

/** Room for the schema's own field names; a foreign file's unknown keys past this many are a count. */
const MAX_NAMED_DROPPED_FIELDS = 10;

type PendingImport = Extract<ParseImportResult, { ok: true }>;

type ImportMode = "replace" | "merge";

/** What a picked file became: the import to confirm, or the notice that refused it. */
type ImportRead = { ok: true; pending: PendingImport } | { ok: false; failure: ErrorPayload };

/** The writes this section performs, from the one useSettings the section mounts. */
type BackupWrites = Pick<
  ReturnType<typeof useSettings>,
  "syncEnabled" | "updateWithBackup" | "restoreBackup" | "discardBackup"
>;

interface BackupMutationsOptions {
  settings: Settings;
  writes: BackupWrites;
  setFailure: (failure: ErrorPayload | null) => void;
  setSuccess: (text: string) => void;
  closePanel: () => void;
}

interface RestoreRowProps {
  savedAt: string;
  restoring: boolean;
  busy: boolean;
  onRestore: () => Promise<void>;
  onDiscard: () => Promise<void>;
}

interface ImportConfirmPanelProps {
  ref: Ref<HTMLFieldSetElement>;
  pending: PendingImport;
  importBackup: { savedAt: string } | null;
  confirming: ImportMode | null;
  busy: boolean;
  onConfirm: (parsed: PendingImport, mode: ImportMode) => Promise<void>;
  onCancel: () => void;
}

interface OutcomeLinesProps {
  failure: Report<ErrorPayload> | null;
  writeFailure: Report<ErrorPayload> | null;
  success: string;
}

function droppedFieldsNotice(fields: string[]): string {
  const named = fields.slice(0, MAX_NAMED_DROPPED_FIELDS).join(", ");
  const rest = fields.length - MAX_NAMED_DROPPED_FIELDS;
  return rest > 0
    ? i18n.t("settings.backup_import_dropped_more", [named, String(rest)])
    : i18n.t("settings.backup_import_dropped", [named]);
}

/** Which providers' credentials the file carries, disclosed before the import is applied. */
function credentialsNotice(providerIds: ProviderId[]): string {
  if (providerIds.length === 0) return i18n.t("settings.backup_import_no_credentials");
  const names = providerIds.map((id) => tDynamic(getProvider(id).labelKey)).join(", ");
  return i18n.t("settings.backup_import_providers", [names]);
}

function importFailure(message: string, detail: string): ErrorPayload {
  return { title: i18n.t("settings.backup_import_failed_title"), message, detail };
}

function exportFailure(error: unknown): ErrorPayload {
  return {
    title: i18n.t("settings.backup_export_failed_title"),
    message: i18n.t("settings.backup_export_failed"),
    detail: errorText(error),
  };
}

/** A blob: URL, not data:, because DownloadItem.url is recorded in download history and would
 *  persist the API keys beyond the file. No saveAs: the native dialog can steal focus and
 *  close the popup, and a blob: URL dies with the popup document.
 *  @throws the download request's rejection, with the URL already revoked */
async function downloadExport(settings: Settings, now: Date): Promise<void> {
  const url = URL.createObjectURL(
    new Blob([serializeExport(buildExport(settings, now))], { type: "application/json" }),
  );
  try {
    const downloadId = await browser.downloads.download({ url, filename: exportFilename(now) });
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
    throw error;
  }
}

/** The size guard runs before the read, so an oversized file never reaches popup memory. */
async function readImportFile(file: File): Promise<ImportRead> {
  if (file.size > MAX_IMPORT_FILE_BYTES) {
    const detail = `ImportFileTooLarge: ${file.size} bytes > MAX_IMPORT_FILE_BYTES ${MAX_IMPORT_FILE_BYTES}`;
    return { ok: false, failure: importFailure(i18n.t("settings.backup_file_too_large"), detail) };
  }

  let text: string;
  try {
    text = await file.text();
  } catch (error) {
    const failure = importFailure(i18n.t("settings.backup_read_failed"), errorText(error));
    return { ok: false, failure };
  }

  const parsed = parseImport(text);
  if (!parsed.ok) return { ok: false, failure: describeImportFailure(parsed) };

  return { ok: true, pending: parsed };
}

function importedSettings(current: Settings, parsed: PendingImport, mode: ImportMode): Settings {
  if (mode === "replace") return parsed.settings;
  return mergeSettings(current, parsed.patch);
}

/** Advisory pre-check only; the write itself stays the authority. */
function syncQuotaRefusal(
  settings: Settings,
  parsed: PendingImport,
  mode: ImportMode,
): ErrorPayload | null {
  const size = estimateSyncSizeBytes(importedSettings(settings, parsed, mode));
  if (size <= SYNC_QUOTA_BYTES_PER_ITEM) return null;

  const detail = `ImportTooLargeToSync: ${mode} estimate ${size} bytes > QUOTA_BYTES_PER_ITEM ${SYNC_QUOTA_BYTES_PER_ITEM}`;
  return importFailure(i18n.t("settings.backup_import_too_large"), detail);
}

/** The file input and what its latest pick became. Only the latest selection may open or replace
 *  the confirm panel: a slow read of file A must not clobber B, and a read still running when the
 *  picker reopens must not reopen the panel after the user cancels. */
function useImportPicker(onRefused: (failure: ErrorPayload) => void) {
  const input = useRef<HTMLInputElement>(null);
  const generation = useRef(0);
  const [pending, setPending] = useState<PendingImport | null>(null);

  async function read(file: File) {
    const picked = ++generation.current;
    setPending(null);
    const outcome = await readImportFile(file);
    if (picked !== generation.current) return;

    if (outcome.ok) setPending(outcome.pending);
    else onRefused(outcome.failure);
  }

  /** A canceled OS picker fires no change event, so the previous panel is cleared now. */
  function open() {
    generation.current++;
    setPending(null);
    input.current?.click();
  }

  function handleChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so re-selecting the same file fires change again.
    event.target.value = "";
    if (file) void read(file);
  }

  function clear() {
    setPending(null);
  }

  return { input, pending, open, handleChange, clear };
}

/** Replace or Merge, Restore, and Discard, one at a time. A ref guards the overlap, not state: a
 *  second Replace/Merge activation would snapshot the already-imported settings and destroy the
 *  pre-import restore point, and async state updates land too late to block it. */
function useBackupMutations({
  settings,
  writes,
  setFailure,
  setSuccess,
  closePanel,
}: BackupMutationsOptions) {
  const inFlight = useRef(false);
  const [confirming, setConfirming] = useState<ImportMode | null>(null);
  const [restoring, setRestoring] = useState(false);

  async function confirm(parsed: PendingImport, mode: ImportMode) {
    if (inFlight.current) return;
    setFailure(null);

    if (writes.syncEnabled) {
      const refusal = syncQuotaRefusal(settings, parsed, mode);
      if (refusal) {
        setFailure(refusal);
        return;
      }
    }

    inFlight.current = true;
    setConfirming(mode);
    try {
      const written = await writes.updateWithBackup((current) =>
        importedSettings(current, parsed, mode),
      );
      // Failed write: the panel stays open and writeFailure explains it.
      if (!written) return;
      sendToBackground("fetchVoices").catch(() => {});
      closePanel();
      // An imported uiLanguage change remounts the tree (App.tsx) and loses this line; accepted.
      setSuccess(i18n.t("settings.backup_import_success"));
    } finally {
      inFlight.current = false;
      setConfirming(null);
    }
  }

  async function restore() {
    if (inFlight.current) return;
    setFailure(null);
    setSuccess("");
    inFlight.current = true;
    setRestoring(true);
    try {
      const restored = await writes.restoreBackup();
      if (!restored) return;
      sendToBackground("fetchVoices").catch(() => {});
      // An open confirm panel must not survive the restore and offer to import over the
      // just-restored settings.
      closePanel();
      setSuccess(i18n.t("settings.backup_restore_success"));
    } finally {
      inFlight.current = false;
      setRestoring(false);
    }
  }

  async function discard() {
    if (inFlight.current) return;
    setFailure(null);
    setSuccess("");
    inFlight.current = true;
    try {
      // No success line: the row disappears reactively via importBackup.
      await writes.discardBackup();
    } finally {
      inFlight.current = false;
    }
  }

  return {
    confirming,
    restoring,
    busy: confirming !== null || restoring,
    confirm,
    restore,
    discard,
  };
}

function ActionsRow({ onExport, onImport }: { onExport: () => void; onImport: () => void }) {
  return (
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-semibold text-body">{i18n.t("settings.backup_label")}</div>
        <div className="text-xxs text-muted">{i18n.t("settings.backup_hint")}</div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button onClick={onExport}>{i18n.t("settings.backup_export")}</Button>
        <Button onClick={onImport}>{i18n.t("settings.backup_import")}</Button>
      </div>
    </div>
  );
}

function RestoreRow({ savedAt, restoring, busy, onRestore, onDiscard }: RestoreRowProps) {
  return (
    <div className="flex items-center gap-3 border-t border-edge pt-2.5">
      <div className="min-w-0 flex-1 text-xxs text-muted">
        {i18n.t("settings.backup_restore_hint", [new Date(savedAt).toLocaleDateString()])}
      </div>
      <div className="flex shrink-0 gap-2">
        <Button submitting={restoring} disabled={busy} onClick={() => void onRestore()}>
          {i18n.t("settings.backup_restore")}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => void onDiscard()}>
          {i18n.t("settings.backup_discard")}
        </Button>
      </div>
    </div>
  );
}

function ImportConfirmPanel({
  ref,
  pending,
  importBackup,
  confirming,
  busy,
  onConfirm,
  onCancel,
}: ImportConfirmPanelProps) {
  return (
    <fieldset
      ref={ref}
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
      <div>{credentialsNotice(pending.providersWithCredentials)}</div>
      {pending.droppedFields.length > 0 && <div>{droppedFieldsNotice(pending.droppedFields)}</div>}
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
          onClick={() => void onConfirm(pending, "replace")}
        >
          {i18n.t("settings.backup_replace")}
        </Button>
        <Button
          submitting={confirming === "merge"}
          disabled={busy}
          onClick={() => void onConfirm(pending, "merge")}
        >
          {i18n.t("settings.backup_merge")}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={onCancel}>
          {i18n.t("common.cancel")}
        </Button>
      </div>
    </fieldset>
  );
}

/** This section's own failure first: a refused write explains the panel that stays open. */
function OutcomeLines({ failure, writeFailure, success }: OutcomeLinesProps) {
  const shown = failure ?? writeFailure;
  return (
    <>
      {shown && <ErrorNotice error={shown.value} reportKey={shown.key} className="mt-2" />}
      {success && (
        <div role="status" className="mt-2 text-xxs font-semibold text-success">
          {success}
        </div>
      )}
    </>
  );
}

/** All decision logic lives in lib/settings/settings-transfer. `settings` comes from the view that resolved
 *  the record, so this section never hides; its own read failure shows as its notice. */
export function BackupSection({ settings }: { settings: Settings }) {
  const store = useSettings();
  const [failure, setFailure] = useReport<ErrorPayload>();
  const [success, setSuccess] = useState("");
  const picker = useImportPicker(setFailure);
  const mutations = useBackupMutations({
    settings,
    writes: store,
    setFailure,
    setSuccess,
    closePanel: picker.clear,
  });
  const panel = useRef<HTMLFieldSetElement>(null);

  // The confirm panel appears below the trigger, silently to screen readers, and a second file
  // selection swaps its content in place, so focus moves to it whenever it (re)opens.
  useEffect(() => {
    if (picker.pending) panel.current?.focus();
  }, [picker.pending]);

  /** For the flows that leave the panel without a write; a write clears its own rejection. */
  function resetOutcome() {
    setFailure(null);
    setSuccess("");
    store.clearWriteError();
  }

  async function handleExport() {
    resetOutcome();
    try {
      await downloadExport(settings, new Date());
    } catch (error) {
      setFailure(exportFailure(error));
    }
  }

  function handleImport() {
    resetOutcome();
    picker.open();
  }

  function handleCancel() {
    picker.clear();
    resetOutcome();
  }

  return (
    <div>
      <SectionTitle>{i18n.t("settings.backup_title")}</SectionTitle>
      <Card className="flex flex-col gap-2.5">
        <ActionsRow onExport={() => void handleExport()} onImport={handleImport} />
        {store.importBackup && (
          <RestoreRow
            savedAt={store.importBackup.savedAt}
            restoring={mutations.restoring}
            busy={mutations.busy}
            onRestore={mutations.restore}
            onDiscard={mutations.discard}
          />
        )}
      </Card>
      <input
        ref={picker.input}
        type="file"
        accept="application/json"
        className="hidden"
        onChange={picker.handleChange}
      />
      {picker.pending && (
        <ImportConfirmPanel
          ref={panel}
          pending={picker.pending}
          importBackup={store.importBackup}
          confirming={mutations.confirming}
          busy={mutations.busy}
          onConfirm={mutations.confirm}
          onCancel={handleCancel}
        />
      )}
      <OutcomeLines failure={failure} writeFailure={store.writeFailure} success={success} />
    </div>
  );
}
