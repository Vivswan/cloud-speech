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
 *  the request reads its own error first: only it knows an account out of
 *  credit behind a throttling status (no wait makes that one pass) or a
 *  throttle behind an SDK exception whose status is a 400. An error it does
 *  not recognize is judged by its HTTP status alone. */
export function isTransientProviderError(error: unknown, provider?: ErrorReader): boolean {
  const kind = provider?.describeError?.(error)?.kind;
  if (kind !== undefined) return kind === "rate_limited" || kind === "provider_outage";
  return error instanceof ProviderHttpError && isRetryableStatus(error.status);
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
