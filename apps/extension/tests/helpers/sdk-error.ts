/** An AWS SDK error: named, with the HTTP status in its response metadata. */
export function sdkError(name: string, httpStatusCode: number): Error {
  const error = Object.assign(new Error(name), { name });
  Reflect.set(error, "$metadata", { httpStatusCode });
  return error;
}

/** An AWS SDK command output: `fields` plus the response metadata every
 *  output carries, with the HTTP status the service answered. */
export function sdkOutput(fields: Record<string, unknown>, httpStatusCode = 200): unknown {
  const output: Record<string, unknown> = { ...fields };
  Reflect.set(output, "$metadata", { httpStatusCode });
  return output;
}
