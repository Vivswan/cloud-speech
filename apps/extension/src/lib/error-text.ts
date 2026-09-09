/** The technical text of a thrown value, for a notice's Details: what it
 *  stringifies to, or a line saying it had none, so the Details a notice
 *  always carries never render blank (a rejected promise can carry an empty
 *  string). Redaction is the caller's: this is the intact text. */
export function errorText(error: unknown): string {
  const text = String(error);
  return text.trim() === "" ? "Error: the thrown value has no text" : text;
}
