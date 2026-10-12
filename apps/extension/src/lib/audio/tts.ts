import { uint8ArrayToBase64 } from "uint8array-extras";
import type { ErrorReader } from "../messaging/provider-http";
import { retryTransient } from "../messaging/retry";

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

export function bytesToDataUri(bytes: Uint8Array, extension: string): string {
  return `data:audio/${extension};base64,${uint8ArrayToBase64(bytes)}`;
}

/** An aborted `signal` or a failed item stops further items and backoffs, so
 *  a read that has already failed makes no more provider calls; requests
 *  already in flight run to completion unless the caller cancels them through
 *  `signal`. Rejects with the first failure, or the abort reason. */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
  provider?: ErrorReader,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  const failed = new AbortController();
  const stop = signal ? AbortSignal.any([signal, failed.signal]) : failed.signal;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < items.length) {
      stop.throwIfAborted();
      const index = next++;
      try {
        results[index] = await retryTransient(() => fn(items[index]!, index), stop, provider);
      } catch (error) {
        failed.abort(error);
        throw error;
      }
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker);
  await Promise.all(workers);
  return results;
}
