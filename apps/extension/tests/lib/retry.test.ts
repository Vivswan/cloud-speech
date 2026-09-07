import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProviderHttpError } from "@/lib/provider-http";
import { isTransientProviderError, retryTransient } from "@/lib/retry";
import { SlotAbortError } from "@/lib/slot";
import { mapWithConcurrency } from "@/lib/tts";

const http = (status: number) => new ProviderHttpError("azure", "synthesis", status);

/** An AWS SDK error: named, with the HTTP status in its response metadata. */
function sdkError(name: string, httpStatusCode: number): Error {
  const error = Object.assign(new Error(name), { name });
  Reflect.set(error, "$metadata", { httpStatusCode });
  return error;
}

describe("isTransientProviderError", () => {
  const cases: Array<{ label: string; error: unknown; expected: boolean }> = [
    { label: "HTTP 429", error: http(429), expected: true },
    { label: "HTTP 500", error: http(500), expected: true },
    { label: "HTTP 503", error: http(503), expected: true },
    { label: "HTTP 400", error: http(400), expected: false },
    { label: "HTTP 401", error: http(401), expected: false },
    { label: "HTTP 403", error: http(403), expected: false },
    {
      label: "a Polly ThrottlingException (status 400)",
      error: sdkError("ThrottlingException", 400),
      expected: true,
    },
    {
      label: "a Polly ServiceFailureException (status 500)",
      error: sdkError("ServiceFailureException", 500),
      expected: true,
    },
    {
      label: "a Polly InvalidClientTokenId (status 403)",
      error: sdkError("InvalidClientTokenId", 403),
      expected: false,
    },
    { label: "a cancellation", error: new SlotAbortError("superseded"), expected: false },
    { label: "a network TypeError", error: new TypeError("Failed to fetch"), expected: false },
    { label: "a plain Error", error: new Error("No voices returned"), expected: false },
    { label: "a string", error: "503", expected: false },
  ];
  for (const { label, error, expected } of cases) {
    it(`is ${expected} for ${label}`, () => {
      expect(isTransientProviderError(error)).toBe(expected);
    });
  }
});

describe("retryTransient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Jitter factor 1: delays are exactly 500 ms, then 1000 ms.
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries 429 then 5xx with 500 ms and 1000 ms backoffs and returns the third result", async () => {
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(http(429))
      .mockRejectedValueOnce(http(503))
      .mockResolvedValue("audio");
    const outcome = retryTransient(request);
    // Silence the unhandled-rejection tracker while the promise is pending.
    outcome.catch(() => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(499);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(request).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(3);

    await expect(outcome).resolves.toBe("audio");
  });

  it("jitters the first backoff by a factor in [1, 2)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const request = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(http(503))
      .mockResolvedValue("audio");
    const outcome = retryTransient(request);

    await vi.advanceTimersByTimeAsync(749);
    expect(request).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(request).toHaveBeenCalledTimes(2);
    await expect(outcome).resolves.toBe("audio");
  });

  it("gives up after three attempts with the last error", async () => {
    const errors = [http(503), http(502), http(500)];
    const request = vi.fn<() => Promise<string>>();
    for (const error of errors) request.mockRejectedValueOnce(error);
    const outcome = retryTransient(request);
    outcome.catch(() => {});

    await vi.advanceTimersByTimeAsync(500 + 1000);
    expect(request).toHaveBeenCalledTimes(3);
    await expect(outcome).rejects.toBe(errors[2]);
  });

  const immediate = [
    { label: "HTTP 401", error: http(401) },
    { label: "HTTP 400", error: http(400) },
    { label: "a cancellation", error: new SlotAbortError("superseded") },
    { label: "a schema error", error: new Error("No voices returned by Azure") },
  ];
  for (const { label, error } of immediate) {
    it(`rejects ${label} at once without a second attempt`, async () => {
      const request = vi.fn<() => Promise<string>>().mockRejectedValue(error);
      const outcome = retryTransient(request);
      outcome.catch(() => {});

      await vi.advanceTimersByTimeAsync(10_000);
      expect(request).toHaveBeenCalledTimes(1);
      await expect(outcome).rejects.toBe(error);
    });
  }

  it("stops the backoff at once when the signal aborts, rejecting with its reason", async () => {
    const controller = new AbortController();
    const request = vi.fn<() => Promise<string>>().mockRejectedValue(http(503));
    const outcome = retryTransient(request, controller.signal);
    outcome.catch(() => {});

    await vi.advanceTimersByTimeAsync(100);
    expect(request).toHaveBeenCalledTimes(1);
    const reason = new SlotAbortError("superseded");
    controller.abort(reason);

    await expect(outcome).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(request).toHaveBeenCalledTimes(1);
  });
});

describe("mapWithConcurrency retries", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("retries one throttled chunk and keeps every result in order", async () => {
    let throttled = false;
    const attempts: number[] = [];
    const outcome = mapWithConcurrency([1, 2, 3], 2, async (n) => {
      attempts.push(n);
      if (n === 2 && !throttled) {
        throttled = true;
        throw http(429);
      }
      return n * 10;
    });

    await vi.advanceTimersByTimeAsync(500);
    await expect(outcome).resolves.toEqual([10, 20, 30]);
    expect(attempts).toEqual([1, 2, 3, 2]);
  });

  it("does not retry a chunk once the signal aborts during its backoff", async () => {
    const controller = new AbortController();
    const attempts: number[] = [];
    const outcome = mapWithConcurrency(
      [1, 2],
      1,
      async (n) => {
        attempts.push(n);
        throw http(503);
      },
      controller.signal,
    );
    outcome.catch(() => {});

    await vi.advanceTimersByTimeAsync(100);
    const reason = new SlotAbortError("released");
    controller.abort(reason);

    await expect(outcome).rejects.toBe(reason);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(attempts).toEqual([1]);
  });
});
