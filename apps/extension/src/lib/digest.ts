/** Cheap stable digest for comparing "is this the same text?" across the
 *  popup and the background (djb2-xor + length; NOT cryptographic). 32 bits
 *  are enough here: a collision only makes the popup's "this is my text"
 *  match a different read's text, and nothing plays or persists on it.
 *  Text only: anything that keys a cache or a dedupe registry on credentials
 *  or settings goes through credentialsDigest; a test pins the call sites. */
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
 *  irrelevant. Full SHA-256 (64 hex chars), because at textDigest's 32 bits
 *  distinct credential sets do collide and the cache would replay another
 *  server's audio. Deterministic across contexts: a fresh service worker
 *  computes the same key for the same persisted settings. */
export async function credentialsDigest(credentials: Record<string, string>): Promise<string> {
  const fields = Object.entries(credentials).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const bytes = new TextEncoder().encode(JSON.stringify(fields));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
