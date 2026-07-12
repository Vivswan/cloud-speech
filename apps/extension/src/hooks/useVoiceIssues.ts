import { useEffect, useState } from "react";
import { voiceIssuesItem } from "@/lib/storage";

/** Reactive map of voices whose last synthesis/scan failed:
 *  `providerId:voiceId` → the provider's error message. */
export function useVoiceIssues(): Record<string, string> {
  const [issues, setIssues] = useState<Record<string, string>>({});

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
