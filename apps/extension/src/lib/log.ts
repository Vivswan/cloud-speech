import { errorText } from "./error-text";
import { ProviderHttpError } from "./provider-http";
import { redactSecrets, statusFromError } from "./provider-validation";

/** A console line survives in screenshots and pasted logs, so a thrown value
 *  is logged as one bounded line and never as the object: a proxy's 401 body
 *  can echo the key it rejected. The configured keys are not at hand here
 *  (the settings reader imports the protocol module that logs), so the body
 *  of a provider answer stays out altogether; the toast's Details show it,
 *  redacted against the configured keys (lib/errors.ts).
 *
 *  ProviderHttpError  -> name, provider, operation, HTTP status
 *  anything else      -> its text redacted by shape, plus the HTTP status it carries
 */
const MAX_TEXT = 300;

/** Never throws: the value may have a throwing toString, and a log call must
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
