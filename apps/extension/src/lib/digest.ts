/** Cheap stable digest for comparing "is this the same text?" across the
 *  popup and the background (djb2-xor + length; NOT cryptographic). 32 bits
 *  are enough here: a collision only makes the popup's "this is my text"
 *  match a different read's text, and nothing plays or persists on it.
 *  Text only: anything keyed on credentials or settings uses
 *  canonicalCredentials or credentialsDigest; a test pins the call sites. */
export function textDigest(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(36)}:${text.length}`;
}

/** The credential fields as one string, sorted by key so field order is
 *  irrelevant: distinct credential sets always give distinct strings. Keys
 *  in-memory registries directly (synchronous, so a lookup and the work it
 *  guards run in the same tick) and is what credentialsDigest hashes. */
export function canonicalCredentials(credentials: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(credentials).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** The identity of a credential set for cache keys: audio one endpoint or key
 *  produced must not answer for another, and a key that outlives the context
 *  (IndexedDB) must not carry the credentials themselves. Field order is
 *  irrelevant. Full SHA-256 (64 hex chars), because at textDigest's 32 bits
 *  distinct credential sets do collide and the cache would replay another
 *  server's audio. Deterministic across contexts: a fresh service worker
 *  computes the same key for the same persisted settings. */
export async function credentialsDigest(credentials: Record<string, string>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCredentials(credentials));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
