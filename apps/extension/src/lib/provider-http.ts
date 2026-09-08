import { PROVIDER_NAMES, type ProviderId } from "@cloud-speech/constants";
import { isAbortError } from "./slot";

export type ProviderOperation = "synthesis" | "voices" | "validation";

/** A provider answered with an HTTP response the caller cannot use: a non-2xx
 *  status, or a 2xx whose body is not audio. Carries the status so the
 *  validation classifier and the retry policy never parse it out of text. */
export class ProviderHttpError extends Error {
  override readonly name = "ProviderHttpError";

  constructor(
    readonly provider: ProviderId,
    readonly operation: ProviderOperation,
    readonly status: number,
    detail = "",
  ) {
    super(
      `${PROVIDER_NAMES[provider]} ${operation} failed: HTTP ${status}${detail ? ` (${detail})` : ""}`,
    );
  }
}

/** The detail of a 2xx synthesis answer that carried no audio bytes. */
export const NO_AUDIO_DETAIL = "no audio in the response";

/** A 2xx whose body is a page or a JSON envelope where audio bytes belong:
 *  a proxy's login page, or a quota notice the service sent with the wrong
 *  status. Playing either as audio yields silence or noise. */
export function isNonAudioResponse(response: Response): boolean {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  return type.includes("text/html") || type.includes("application/json");
}

/** The audio bytes of a synthesis `response`, or the error for one that has
 *  none: a failed status, a non-audio body, or a 2xx with nothing in it.
 *  Zero bytes would play as silence and later read as "audio is gone", with
 *  no hint that the service returned nothing; the error names it instead. */
export async function audioBytes(
  provider: ProviderId,
  operation: ProviderOperation,
  response: Response,
): Promise<Uint8Array> {
  if (!response.ok) throw await providerHttpError(provider, operation, response);
  // A page or envelope in place of audio: its text is the detail, or, when
  // that is empty too, the fact that no audio came.
  if (isNonAudioResponse(response)) {
    throw await providerHttpError(provider, operation, response, NO_AUDIO_DETAIL);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new ProviderHttpError(provider, operation, response.status, NO_AUDIO_DETAIL);
  }
  return bytes;
}

/** Build the error for a failed `response`, reading its body for the detail;
 *  `fallbackDetail` stands in when the body has nothing to say. */
export async function providerHttpError(
  provider: ProviderId,
  operation: ProviderOperation,
  response: Response,
  fallbackDetail = "",
): Promise<ProviderHttpError> {
  const detail = (await errorDetail(response)) || fallbackDetail;
  return new ProviderHttpError(provider, operation, response.status, detail);
}

/** The failed body as the user should read it: an OpenAI/Google style
 *  `{ error: { message } }` envelope unwrapped, anything else verbatim and
 *  untruncated (the server's text is often the only clue the user gets). */
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
