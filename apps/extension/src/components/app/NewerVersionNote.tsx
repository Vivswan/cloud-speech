import { ErrorNotice } from "@/components/app/ErrorNotice";
import { describeNewerVersion } from "@/hooks/useSettings";

interface NewerVersionNoteProps {
  storedVersion: number;
}

/** A state, not a failure, so it takes the note tone and never dismisses itself; the shape is the
 *  error notice's so it reads like the refused-write notice it stands in for. */
export function NewerVersionNote({ storedVersion }: NewerVersionNoteProps) {
  return <ErrorNotice error={describeNewerVersion(storedVersion)} tone="note" />;
}
