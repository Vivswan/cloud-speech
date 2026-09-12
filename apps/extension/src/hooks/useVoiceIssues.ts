import { useEffect, useState } from "react";
import { readVoiceIssues, type VoiceIssues, watchVoiceIssues } from "@/lib/storage";

/** Nested provider -> voice -> engine, with the failure as the background described it as the
 *  leaf; read it with `voiceIssue`. */
export function useVoiceIssues(): VoiceIssues {
  const [issues, setIssues] = useState<VoiceIssues>({});

  useEffect(() => {
    let mounted = true;
    readVoiceIssues().then((v) => mounted && setIssues(v));
    const unwatch = watchVoiceIssues((v) => mounted && setIssues(v));
    return () => {
      mounted = false;
      unwatch();
    };
  }, []);

  return issues;
}
