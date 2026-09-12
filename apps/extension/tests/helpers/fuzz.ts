import type fc from "fast-check";
import { integerEnv, positiveEnv } from "../../../../scripts/lib/env.mts";

// The one place the fuzz suites read these variables, so scripts/fuzz.mts has one contract to set them by.
//
//   FUZZ_ITERATIONS  replaces every property's run count (the nightly budget)
//   FUZZ_SEED        fixes the seed, so one seed replays the same inputs for every property; unset, fast-check picks one and prints it on failure
//
// Under either variable the failing assertion's text goes into the property's error message, not its `cause`:
// scripts/fuzz.mts reads vitest's JSON reporter, which keeps an error's message and stack but drops its cause.

type FuzzParameters = Pick<fc.Parameters, "numRuns" | "seed" | "includeErrorInReport">;

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
