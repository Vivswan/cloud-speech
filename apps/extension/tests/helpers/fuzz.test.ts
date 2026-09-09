import fc from "fast-check";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fuzzRuns } from "./fuzz";

/** The inputs a property saw under `params`, in order. */
function inputsUnder(params: ReturnType<typeof fuzzRuns>): number[] {
  const seen: number[] = [];
  fc.assert(
    fc.property(fc.integer(), (value) => {
      seen.push(value);
    }),
    params,
  );
  return seen;
}

describe("fuzzRuns", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("without the variables, runs the suite's own count under a seed fast-check picks", () => {
    vi.stubEnv("FUZZ_SEED", undefined);
    vi.stubEnv("FUZZ_ITERATIONS", undefined);
    expect(fuzzRuns(120)).toEqual({ numRuns: 120 });
    expect(inputsUnder(fuzzRuns(7))).toHaveLength(7);
  });

  it("treats a blank variable as unset", () => {
    vi.stubEnv("FUZZ_SEED", "");
    vi.stubEnv("FUZZ_ITERATIONS", "  ");
    expect(fuzzRuns(300)).toEqual({ numRuns: 300 });
  });

  it("FUZZ_ITERATIONS replaces the count for every property", () => {
    vi.stubEnv("FUZZ_ITERATIONS", "5");
    expect(fuzzRuns(300)).toEqual({ numRuns: 5, includeErrorInReport: true });
    expect(fuzzRuns(120)).toEqual({ numRuns: 5, includeErrorInReport: true });
    expect(inputsUnder(fuzzRuns(300))).toHaveLength(5);
  });

  it("FUZZ_SEED makes the same property see the same inputs on every run", () => {
    vi.stubEnv("FUZZ_SEED", "123");
    vi.stubEnv("FUZZ_ITERATIONS", "20");
    expect(fuzzRuns(300)).toEqual({ numRuns: 20, seed: 123, includeErrorInReport: true });
    const first = inputsUnder(fuzzRuns(300));
    expect(first).toHaveLength(20);
    expect(inputsUnder(fuzzRuns(300))).toEqual(first);
    vi.stubEnv("FUZZ_SEED", "124");
    expect(inputsUnder(fuzzRuns(300))).not.toEqual(first);
  });

  it("a failure under FUZZ_SEED reports that seed, the shrunk counterexample, and the assertion's text in the message", () => {
    vi.stubEnv("FUZZ_SEED", "123");
    vi.stubEnv("FUZZ_ITERATIONS", "50");
    expect(() =>
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1000 }), (value) => {
          expect(value).toBeLessThan(500);
        }),
        fuzzRuns(300),
      ),
    ).toThrow(
      /seed: 123[\s\S]*Counterexample: \[500\][\s\S]*Got AssertionError: expected 500 to be less than 500/,
    );
  });

  it("without the variables, a failure keeps the assertion as the error's cause", () => {
    vi.stubEnv("FUZZ_SEED", undefined);
    vi.stubEnv("FUZZ_ITERATIONS", undefined);
    let thrown: unknown;
    try {
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 1000 }), (value) => {
          expect(value).toBeLessThan(500);
        }),
        { ...fuzzRuns(50), seed: 123 },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).not.toContain("Got AssertionError");
    expect(String((thrown as Error).cause)).toContain("expected 500 to be less than 500");
  });

  it.each(["abc", "1.5", "1e3"])("rejects FUZZ_SEED=%s instead of running unseeded", (raw) => {
    vi.stubEnv("FUZZ_SEED", raw);
    expect(() => fuzzRuns(300)).toThrow("FUZZ_SEED must be an integer");
  });

  it("rejects a non-integer FUZZ_ITERATIONS", () => {
    vi.stubEnv("FUZZ_ITERATIONS", "many");
    expect(() => fuzzRuns(300)).toThrow("FUZZ_ITERATIONS must be an integer");
  });
});
