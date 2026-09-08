import pRetry from "p-retry";
import type { TtsProvider } from "@/providers/types";
import { ProviderHttpError } from "./provider-http";

/** The provider whose request failed, asked how it reads its own error. */
export type ErrorReader = Pick<TtsProvider, "describeError">;

/** Attempts per request, including the first. */
export const RETRY_ATTEMPTS = 3;
/** First backoff; doubles per attempt, jittered by a factor in [1, 2). */
export const RETRY_MIN_DELAY_MS = 500;
export const RETRY_MAX_DELAY_MS = 4000;

/** 429 and 5xx are the service's own trouble; everything else is the request's. */
export function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/** A failure worth another attempt: a throttled or failing provider. Never a
 *  bad request, bad credentials, or a cancellation. The `provider` that made
 *  the request may read its own body as an account out of credit behind a
 *  throttling status; no wait makes that one pass. */
export function isTransientProviderError(error: unknown, provider?: ErrorReader): boolean {
  if (error instanceof ProviderHttpError) {
    if (provider?.describeError?.(error)?.kind === "quota_exhausted") return false;
    return isRetryableStatus(error.status);
  }
  if (typeof error !== "object" || error === null) return false;
  // AWS SDK errors: throttling is named (its status is a 400), service
  // trouble carries a 5xx in the response metadata.
  const record = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  if (record.name === "ThrottlingException") return true;
  const status = record.$metadata?.httpStatusCode;
  return typeof status === "number" && isRetryableStatus(status);
}

/** Run `request`, retrying transient provider failures with jittered
 *  exponential backoff. An aborted `signal` ends the backoff at once,
 *  rejecting with the signal's reason; the request in flight is only cut
 *  short if `request` itself honors that same signal (the providers do). */
export function retryTransient<T>(
  request: () => Promise<T>,
  signal?: AbortSignal,
  provider?: ErrorReader,
): Promise<T> {
  return pRetry(request, {
    retries: RETRY_ATTEMPTS - 1,
    factor: 2,
    minTimeout: RETRY_MIN_DELAY_MS,
    maxTimeout: RETRY_MAX_DELAY_MS,
    randomize: true,
    signal,
    shouldRetry: ({ error }) => isTransientProviderError(error, provider),
  });
}
