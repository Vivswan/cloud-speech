/** Cheap stable digest for comparing "is this the same text?" across the
 *  popup and the background (djb2-xor + length; NOT cryptographic). */
export function textDigest(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(36)}:${text.length}`;
}
