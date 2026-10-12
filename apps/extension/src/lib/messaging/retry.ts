import pRetry from "p-retry";
import { describeProviderFailure, type ErrorReader } from "./provider-http";

/** Attempts per request, including the first. */
const RETRY_ATTEMPTS = 3;
/** First backoff; doubles per attempt, jittered by a factor in [1, 2). */
const RETRY_MIN_DELAY_MS = 500;
const RETRY_MAX_DELAY_MS = 4000;

/** The service's own trouble; never a bad request, bad credentials, an account out of credit (no
 *  wait makes that one pass), or a cancellation. */
export function isTransientProviderError(error: unknown, provider?: ErrorReader): boolean {
  const { kind } = describeProviderFailure(error, provider);
  return kind === "rate_limited" || kind === "provider_outage";
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
