/** An AWS SDK error: named, with the HTTP status in its response metadata. */
export function sdkError(name: string, httpStatusCode: number): Error {
  const error = Object.assign(new Error(name), { name });
  Reflect.set(error, "$metadata", { httpStatusCode });
  return error;
}
