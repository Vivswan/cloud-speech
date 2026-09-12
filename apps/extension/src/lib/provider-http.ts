import { PROVIDER_NAMES, type ProviderId } from "@cloud-speech/constants";
import type { FailureKind } from "@/providers/types";
import { isAbortError } from "./slot";

export type ProviderOperation = "synthesis" | "voices" | "validation";

/** Carries the status so the validation classifier and the retry policy never
 *  parse it out of text. A 2xx whose body is not audio counts too. */
export class ProviderHttpError extends Error {
  override readonly name = "ProviderHttpError";

  constructor(
    readonly provider: ProviderId,
    readonly operation: ProviderOperation,
    readonly status: number,
    readonly detail = "",
  ) {
    super(
      `${PROVIDER_NAMES[provider]} ${operation} failed: HTTP ${status}${detail ? ` (${detail})` : ""}`,
    );
  }
}

/** The detail of a 2xx synthesis answer that carried no audio bytes. */
export const NO_AUDIO_DETAIL = "no audio in the response";

/** A proxy's login page, a plain-text quota notice, or an error object sent
 *  with the wrong status would play as silence or noise. Audio types,
 *  octet-stream, and a missing header all pass: custom servers send those for
 *  real audio. */
function isNonAudioResponse(response: Response): boolean {
  const header = response.headers.get("content-type") ?? "";
  const mediaType = header.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return (
    mediaType.startsWith("text/") || mediaType === "application/json" || mediaType.endsWith("+json")
  );
}

/** Zero bytes would play as silence and later read as "audio is gone" with no
 *  hint that the service returned nothing, so an empty 2xx is an error that
 *  names it. */
export async function audioBytes(
  provider: ProviderId,
  operation: ProviderOperation,
  response: Response,
): Promise<Uint8Array> {
  if (!response.ok) throw await providerHttpError(provider, operation, response);
  if (isNonAudioResponse(response)) {
    throw await providerHttpError(provider, operation, response, NO_AUDIO_DETAIL);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new ProviderHttpError(provider, operation, response.status, NO_AUDIO_DETAIL);
  }
  return bytes;
}

/** A status never names a disabled API; only a body read by its provider
 *  does. */
export function failureKindForStatus(status: number): Exclude<FailureKind, "api_disabled"> {
  if (status === 401 || status === 403) return "key_rejected";
  if (status === 429) return "rate_limited";
  if (status >= 500) return "provider_outage";
  if (status >= 400) return "request_refused";
  return "unknown";
}

/** The request never got an answer: fetch's network TypeError (its message
 *  varies by browser), or a deadline (AbortSignal.timeout) that ran out. */
export function isNetworkFailure(error: unknown): boolean {
  if (error instanceof TypeError) {
    return /failed to fetch|networkerror|network request failed|load failed/i.test(error.message);
  }
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "TimeoutError" || error.name === "NetworkError")
  );
}

export async function providerHttpError(
  provider: ProviderId,
  operation: ProviderOperation,
  response: Response,
  fallbackDetail = "",
): Promise<ProviderHttpError> {
  const detail = (await errorDetail(response)) || fallbackDetail;
  return new ProviderHttpError(provider, operation, response.status, detail);
}

/** An OpenAI/Google style `{ error: { message } }` envelope is unwrapped;
 *  anything else is trimmed but never truncated, since the server's text is
 *  often the only clue the user gets. */
async function errorDetail(response: Response): Promise<string> {
  let text: string;
  try {
    text = (await response.text()).trim();
  } catch (error) {
    // A cancellation mid-read stays a cancellation; otherwise the status alone
    // will have to do.
    if (isAbortError(error)) throw error;
    return "";
  }
  try {
    const message = (JSON.parse(text) as { error?: { message?: unknown } } | null)?.error?.message;
    if (typeof message === "string" && message) return message;
  } catch {
    // Not JSON: the text is the detail.
  }
  return text;
}
