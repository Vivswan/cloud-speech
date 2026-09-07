import { i18n } from "@/lib/i18n-runtime";

/** Shown while another device's newer build owns the stored settings: this
 *  build reads them but must not write (see readForWrite in lib/storage.ts). */
export function NewerVersionNote() {
  return (
    <div className="rounded border border-note-edge bg-note p-3 text-xs text-note-text">
      {i18n.t("settings.storage_error_newer")}
    </div>
  );
}
