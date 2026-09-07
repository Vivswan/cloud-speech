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

/** Build the error for a failed `response`, reading its body for the detail. */
export async function providerHttpError(
  provider: ProviderId,
  operation: ProviderOperation,
  response: Response,
): Promise<ProviderHttpError> {
  return new ProviderHttpError(provider, operation, response.status, await errorDetail(response));
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
