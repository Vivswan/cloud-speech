import { useEffect, useState } from "react";
import { type VoiceIssues, voiceIssuesItem } from "@/lib/storage";

/** Reactive record of voices whose last synthesis/scan failed, nested
 *  provider -> voice -> engine (one mark per engine) with the provider's
 *  error message as the leaf; read it with `voiceIssue`. */
export function useVoiceIssues(): VoiceIssues {
  const [issues, setIssues] = useState<VoiceIssues>({});

  useEffect(() => {
    let mounted = true;
    voiceIssuesItem.getValue().then((v) => mounted && setIssues(v));
    const unwatch = voiceIssuesItem.watch((v) => mounted && setIssues(v ?? {}));
    return () => {
      mounted = false;
      unwatch();
    };
  }, []);

  return issues;
}
