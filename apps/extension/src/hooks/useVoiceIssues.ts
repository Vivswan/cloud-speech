import { type StorageSource, useStorageValue } from "@/hooks/useStorageValue";
import { readVoiceIssues, type VoiceIssues, watchVoiceIssues } from "@/lib/storage";

const voiceIssuesSource: StorageSource<VoiceIssues> = {
  getValue: readVoiceIssues,
  watch: watchVoiceIssues,
};

const NO_ISSUES: VoiceIssues = {};

/** Nested provider -> voice -> engine, with the failure as the background described it as the
 *  leaf; read it with `voiceIssue`. */
export function useVoiceIssues(): VoiceIssues {
  return useStorageValue(voiceIssuesSource, NO_ISSUES);
}
