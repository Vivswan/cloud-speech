import type { SelectedVoice } from "@/lib/storage";
import { type NormalizedVoice, PROVIDER_IDS } from "@/providers/types";

// ---------------------------------------------------------------------------
// Composite voice keys, `providerId:voiceId`: favorites, picker rows, and the
// voicesByLanguage memory all use this shape. Voice ids may themselves
// contain colons (Google project-scoped ids), so parsing splits on the FIRST
// colon only.
// ---------------------------------------------------------------------------

export function voiceKey(voice: NormalizedVoice): string {
  return `${voice.providerId}:${voice.id}`;
}

/** Null for malformed keys: no colon, an unknown provider prefix (e.g. a
 *  stale favorite from a removed provider), or an empty voice id. */
export function parseVoiceKey(key: string): SelectedVoice | null {
  const colon = key.indexOf(":");
  if (colon === -1) return null;
  const prefix = key.slice(0, colon);
  const providerId = PROVIDER_IDS.find((id) => id === prefix);
  if (!providerId) return null;
  const voiceId = key.slice(colon + 1);
  if (!voiceId) return null;
  return { providerId, voiceId };
}
