/** A parsed document's object node (YAML and JSON parse to plain objects, arrays, and primitives). */
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
