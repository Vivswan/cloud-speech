import { ProviderHttpError } from "../messaging/provider-http";
import { errorText, statusFromError } from "./error-text";
import { redactSecrets } from "./redaction";

/** A console line survives in screenshots and pasted logs, so a failure is cut to one bounded line. */
const MAX_TEXT = 300;

/** One line, which a failure reply (lib/messaging/protocol.ts) carries to the popup's Details, and
 *  never the object: a proxy's 401 body can echo the key it rejected. The configured keys are not at
 *  hand here (the settings reader imports the protocol module that logs), so a provider answer's body
 *  stays out altogether; the toast's Details show it, redacted against the configured keys
 *  (lib/errors/errors.ts). Never throws: the value may have a throwing toString, and a log call must
 *  not become the failure it reports. */
export function failureLine(error: unknown): string {
  try {
    if (error instanceof ProviderHttpError) return `${error.name}: ${error.summary}`;
    const status = statusFromError(error);
    const text = redactSecrets(errorText(error)).replace(/\s+/g, " ").trim();
    const bounded = text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}...` : text;
    return status === undefined ? bounded : `${bounded} (HTTP ${status})`;
  } catch {
    return "[unprintable error]";
  }
}

export function logError(label: string, error: unknown): void {
  console.error(`${label}: ${failureLine(error)}`);
}

export function logWarning(label: string, error: unknown): void {
  console.warn(`${label}: ${failureLine(error)}`);
}

export function logInfo(message: string): void {
  console.log(message);
}
