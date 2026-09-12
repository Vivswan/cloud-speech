/** djb2-xor plus length, not cryptographic: a collision only makes the popup
 *  take changed text for the parked read, so play resumes the old audio
 *  instead of starting the new text; nothing is synthesized or persisted on
 *  it. Text only: anything keyed on credentials uses canonicalCredentials or
 *  credentialsDigest, and a test pins the call sites. */
export function textDigest(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i++) {
    hash = ((hash * 33) ^ text.charCodeAt(i)) >>> 0;
  }
  return `${hash.toString(36)}:${text.length}`;
}

/** Sorted by key so field order is irrelevant. Synchronous on purpose:
 *  in-memory registries key on it directly, so a lookup and the work it
 *  guards run in the same tick. */
export function canonicalCredentials(credentials: Record<string, string>): string {
  return JSON.stringify(
    Object.entries(credentials).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
  );
}

/** Audio one endpoint or key produced must not answer for another, and a key
 *  that outlives the context (IndexedDB) must not carry the credentials
 *  themselves. Full SHA-256: at textDigest's 32 bits distinct credential sets
 *  do collide, and the cache would replay another server's audio. */
export async function credentialsDigest(credentials: Record<string, string>): Promise<string> {
  const bytes = new TextEncoder().encode(canonicalCredentials(credentials));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
