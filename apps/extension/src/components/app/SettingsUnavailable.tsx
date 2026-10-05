import { ErrorNotice } from "@/components/app/ErrorNotice";
import type { Report } from "@/hooks/useReport";
import type { ErrorPayload } from "@/lib/protocol";

/** What a view shows while useSettings has no record: nothing while the read is in flight, the
 *  read's failure once it is reported. Controls stay hidden in both cases: defaults over settings
 *  that exist but could not be read would invite a write that replaces them. */
export function SettingsUnavailable({ failure }: { failure: Report<ErrorPayload> | null }) {
  return failure && <ErrorNotice error={failure.value} reportKey={failure.key} />;
}
