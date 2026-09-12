// Integer options from the environment, shared by scripts/fuzz.mts and apps/extension/tests/helpers/fuzz.ts
// so both sides refuse the same mistyped values with the same message.

/** A command-line mistake: the runner prints the message and exits 2. */
export class UsageError extends Error {}

/** Blank counts as unset: a blank workflow input means "not given". A set but non-integer value is a
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
