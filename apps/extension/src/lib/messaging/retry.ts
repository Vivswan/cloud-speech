import pRetry from "p-retry";
import type { TtsProvider } from "@/providers/types";
import { ProviderHttpError } from "./provider-http";

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

/** Never a bad request, bad credentials, or a cancellation. The provider
 *  reads its error first: only it knows an account out of credit behind a
 *  throttling status (no wait makes that one pass) or a throttle behind an
 *  SDK exception whose status is a 400. */
export function isTransientProviderError(error: unknown, provider?: ErrorReader): boolean {
  const kind = provider?.describeError?.(error)?.kind;
  if (kind !== undefined) return kind === "rate_limited" || kind === "provider_outage";
  return error instanceof ProviderHttpError && isRetryableStatus(error.status);
}

/** An aborted `signal` ends the backoff at once with the signal's reason; the
 *  request in flight is cut short only if `request` itself honors the same
 *  signal (the providers do). */
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
