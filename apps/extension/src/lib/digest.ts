/** Cheap stable digest for comparing "is this the same text?" across the
 *  popup and the background (djb2-xor + length; NOT cryptographic). */
export function textDigest(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(36)}:${text.length}`;
}

/** The identity of a credential set for cache keys: audio one endpoint or key
 *  produced must not answer for another, and a key that outlives the context
 *  (IndexedDB) must not carry the credentials themselves. Field order is
 *  irrelevant. */
export function credentialsDigest(credentials: Record<string, string>): string {
  const fields = Object.entries(credentials).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return textDigest(JSON.stringify(fields));
}
