import { getProvider } from "@/providers";
import type { NormalizedVoice } from "@/providers/types";
import { type Settings, updateSettingsWith } from "./storage";

// ---------------------------------------------------------------------------
// reconcileSettings: the central invariant keeper. Runs after migration,
// voice fetch, credential changes, provider enable/disable, and voice
// selection. Guarantees that whatever is persisted is actually usable:
// selectedVoice exists in the cache, model/style are supported by that voice,
// encodings are offered by that provider, prosody is within range.
// ---------------------------------------------------------------------------

function findVoice(voices: NormalizedVoice[], selected: Settings["selectedVoice"]) {
  if (!selected) return undefined;
  return voices.find((v) => v.providerId === selected.providerId && v.id === selected.voiceId);
}

function pickFallbackVoice(settings: Settings, voices: NormalizedVoice[]) {
  // Prefer a favorite, then the remembered voice for the current language,
  // then anything from an enabled provider.
  const usable = voices.filter((v) => settings.enabledProviders[v.providerId]);
  if (usable.length === 0) return undefined;

  for (const favorite of settings.favorites) {
    const colon = favorite.indexOf(":");
    if (colon === -1) continue;
    const providerId = favorite.slice(0, colon);
    const voiceId = favorite.slice(colon + 1);
    const match = usable.find((v) => v.providerId === providerId && v.id === voiceId);
    if (match) return match;
  }

  const remembered = settings.voicesByLanguage[settings.language];
  const rememberedMatch = remembered
    ? usable.find((v) => v.providerId === remembered.providerId && v.id === remembered.voiceId)
    : undefined;
  if (rememberedMatch) return rememberedMatch;

  return usable.find((v) => v.languageCodes.includes(settings.language)) ?? usable[0];
}

/** Pure reconciliation of a settings object against the voice cache. */
export function reconcile(settings: Settings, voices: NormalizedVoice[]): Settings {
  const next: Settings = { ...settings };

  // With an empty cache we cannot validate anything; leave the selection
  // alone (a transient fetch failure must never wipe a working setup).
  if (voices.length === 0) return next;

  let voice = findVoice(voices, next.selectedVoice);
  if (!voice || !next.enabledProviders[voice.providerId]) {
    voice = pickFallbackVoice(next, voices);
    next.selectedVoice = voice ? { providerId: voice.providerId, voiceId: voice.id } : null;
  }

  if (!voice) {
    next.style = undefined;
    return next;
  }

  const provider = getProvider(voice.providerId);

  // Model must be supported by both the provider and the specific voice.
  if (!voice.models.includes(next.model)) {
    next.model = voice.models[0] ?? provider.models[0]?.value ?? next.model;
  }

  // Style only when the provider says this voice/model combination supports it.
  if (
    next.style &&
    (!provider.supportsStyle(voice, next.model) || !voice.styles?.includes(next.style))
  ) {
    next.style = undefined;
  }

  // Encodings must be offered by the provider for their purpose.
  const readAloudOk = provider.audioFormats.some(
    (f) => f.id === next.readAloudEncoding && f.forReadAloud,
  );
  if (!readAloudOk) {
    next.readAloudEncoding =
      provider.audioFormats.find((f) => f.forReadAloud)?.id ?? next.readAloudEncoding;
  }
  const downloadOk = provider.audioFormats.some(
    (f) => f.id === next.downloadEncoding && f.forDownload,
  );
  if (!downloadOk) {
    next.downloadEncoding =
      provider.audioFormats.find((f) => f.forDownload)?.id ?? next.downloadEncoding;
  }

  // Clamp prosody into the provider's ranges for the chosen model.
  const ranges = provider.ranges(next.model);
  next.speed = Math.min(Math.max(next.speed, ranges.speed.min), ranges.speed.max);
  next.pitch = Math.min(Math.max(next.pitch, ranges.pitch.min), ranges.pitch.max);
  next.volumeGainDb = Math.min(
    Math.max(next.volumeGainDb, ranges.volumeGainDb.min),
    ranges.volumeGainDb.max,
  );

  return next;
}

/**
 * Reconcile against the cache and persist, as ONE locked fresh-state update
 * (a read-compute-write against a snapshot would clobber concurrent writes,
 * defeating the cross-context serialization).
 */
export function reconcileSettings(voices: NormalizedVoice[]): Promise<Settings> {
  return updateSettingsWith((current) => reconcile(current, voices));
}
