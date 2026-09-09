import { useEffect, useState } from "react";
import { describeFailure } from "@/lib/errors";
import type { ErrorPayload } from "@/lib/protocol";
import { ProviderHttpError, type ProviderOperation } from "@/lib/provider-http";
import { type VoiceIssues, voiceIssuesItem } from "@/lib/storage";
import type { ProviderId } from "@/providers/types";

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

/** `String(error)` of a ProviderHttpError: its name, then the message the
 *  constructor builds from the provider name, operation, status, and the
 *  detail in parentheses. */
const HTTP_ISSUE =
  /^ProviderHttpError: .+? (synthesis|voices|validation) failed: HTTP (\d+)(?: \(([\s\S]*)\))?$/;

/** The notice for a recorded voice issue: the reason in plain words, the
 *  one link that fixes it, and the recorded text as the detail. The store
 *  keeps a failure as the text it stringified to, while a provider only
 *  recognizes its own errors as ProviderHttpError instances, so an HTTP
 *  failure is read back into one before it is described; any other text is
 *  described as it is. */
export function describeVoiceIssue(providerId: ProviderId, issue: string): ErrorPayload {
  const http = HTTP_ISSUE.exec(issue);
  const error = http
    ? new ProviderHttpError(providerId, http[1] as ProviderOperation, Number(http[2]), http[3])
    : issue;
  return describeFailure(error, { providerId });
}
