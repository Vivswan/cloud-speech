import { ErrorNotice } from "@/components/app/ErrorNotice";
import { describeNewerVersion } from "@/hooks/useSettings";

interface NewerVersionNoteProps {
  /** The schema version the newer build saved; shown under Details. */
  storedVersion: number;
}

/** Shown while another device's newer build owns the stored settings: this
 *  build reads them but must not write (see readForWrite in lib/storage.ts).
 *  A state, not a failure, so it takes the note tone and never dismisses
 *  itself; the shape (title, sentence, action, detail) is the error notice's
 *  so it reads like the refused-write notice it stands in for. */
export function NewerVersionNote({ storedVersion }: NewerVersionNoteProps) {
  return <ErrorNotice error={describeNewerVersion(storedVersion)} tone="note" />;
}
