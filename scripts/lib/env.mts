// Integer options read from the environment, shared by the fuzz runner
// (scripts/fuzz.mts, SEED / ITERATIONS / FUZZ_TIMEOUT_MINUTES) and the
// fast-check helper the suites use (apps/extension/tests/helpers/fuzz.ts,
// FUZZ_SEED / FUZZ_ITERATIONS), so both sides read a value the same way and
// refuse the same mistyped ones with the same message.

/** A command-line mistake: the runner prints the message and exits 2. */
export class UsageError extends Error {}

/** The variable's value as an integer, or undefined when unset or blank (a
 *  blank workflow input means "not given"). A set but non-integer value is a
 *  mistyped command and fails loudly instead of silently taking a default. */
export function integerEnv(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new UsageError(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  }
  return Number(raw);
}

/** `integerEnv`, and the value must be at least 1 (a count or a duration). */
export function positiveEnv(
  env: Record<string, string | undefined>,
  name: string,
): number | undefined {
  const value = integerEnv(env, name);
  if (value !== undefined && value < 1) {
    throw new UsageError(`${name} must be at least 1, got ${value}`);
  }
  return value;
}
