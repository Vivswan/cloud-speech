import { ProviderHttpError } from "../messaging/provider-http";
import { isRecord } from "../messaging/record";

// What a thrown value carries, read by shape. Redaction is the caller's: this
// is the intact text.

/** A rejected promise can carry an empty string, and the Details a notice
 *  carries must never render blank. */
export function errorText(error: unknown): string {
  const text = String(error);
  return text.trim() === "" ? "Error: the thrown value has no text" : text;
}

export function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** An SDK error carries its status as a field (`statusCode`, or Polly's
 *  `$metadata.httpStatusCode`); a plain error only in its text. */
export function statusFromError(error: unknown): number | undefined {
  if (error instanceof ProviderHttpError) return error.status;
  if (!isRecord(error)) return undefined;

  for (const value of [error.status, error.statusCode]) {
    if (typeof value === "number") return value;
  }

  const metadata = error.$metadata;
  if (isRecord(metadata) && typeof metadata.httpStatusCode === "number")
    return metadata.httpStatusCode;

  const message = stringValue(error.message);
  const statusMatch = message?.match(/\b([45]\d\d)\b/);
  return statusMatch?.[1] ? Number(statusMatch[1]) : undefined;
}
