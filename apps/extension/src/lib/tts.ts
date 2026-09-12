import { type ErrorReader, retryTransient } from "./retry";

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

/** Converts in 8192-byte windows: `String.fromCharCode(...bytes)` over a
 *  large buffer overflows the call stack. */
export function bytesToDataUri(bytes: Uint8Array, extension: string): string {
  const WINDOW = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += WINDOW) {
    binary += String.fromCharCode(...bytes.subarray(i, i + WINDOW));
  }
  return `data:audio/${extension};base64,${btoa(binary)}`;
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
