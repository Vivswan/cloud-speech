import type fc from "fast-check";
import { integerEnv, positiveEnv } from "../../../../scripts/lib/env.mts";

// The one place the fuzz suites take their fast-check parameters from. A
// per-assert parameter object overrides fast-check's global configuration,
// so a seed or run count can only reach a property through here.
//
//   FUZZ_ITERATIONS  replaces every property's run count (the nightly budget)
//   FUZZ_SEED        fixes fast-check's seed, so the same seed replays the
//                    same inputs for every property; unset means fast-check
//                    picks one and prints it in the failure message
//
// Without either variable a suite runs exactly as it always has: the run
// count it names, a fresh seed. Shrinking stays on, so a failure reports the
// minimal counterexample along with the seed and path that reach it.
//
// Under either variable the failing assertion's text is written into the
// property's error message instead of hanging off it as `cause`: the runner
// (scripts/fuzz.mts) learns what failed from vitest's JSON reporter, which
// keeps an error's message and stack but drops its cause.

type FuzzParameters = Pick<fc.Parameters, "numRuns" | "seed" | "includeErrorInReport">;

/** The parameters a property passes to `fc.assert`: the suite's own run
 *  count unless FUZZ_ITERATIONS is set, and the seed FUZZ_SEED names. */
export function fuzzRuns(defaultRuns: number): FuzzParameters {
  const seed = integerEnv(process.env, "FUZZ_SEED");
  const iterations = positiveEnv(process.env, "FUZZ_ITERATIONS");
  if (seed === undefined && iterations === undefined) return { numRuns: defaultRuns };
  const parameters: FuzzParameters = {
    numRuns: iterations ?? defaultRuns,
    includeErrorInReport: true,
  };
  return seed === undefined ? parameters : { ...parameters, seed };
}
