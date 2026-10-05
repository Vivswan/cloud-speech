/** An array is an object too, and every reader here would misread one: `Object.entries` yields its
 *  index keys, and the protocol's Zod objects refuse it. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
