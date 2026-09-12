/** A rejected promise can carry an empty string, and the Details a notice
 *  carries must never render blank. Redaction is the caller's: this is the
 *  intact text. */
export function errorText(error: unknown): string {
  const text = String(error);
  return text.trim() === "" ? "Error: the thrown value has no text" : text;
}
