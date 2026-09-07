import { getProvider } from "@/providers";
import type { NormalizedVoice } from "@/providers/types";
import { isProviderEnabled, prefsFor, withProviderPrefs } from "./provider-state";
import { type Selection, type Settings, updateSettingsWith, type VoiceRef } from "./storage";
import { parseVoiceKey } from "./voice-key";

// ---------------------------------------------------------------------------
// reconcileSettings: the central invariant keeper. Runs after startup, voice
// fetch, credential changes, provider enable/disable, and voice selection.
// Guarantees that whatever is persisted is actually usable: the selection
// names a voice the cache has on an engine it offers, from an enabled
// provider; its style is one of that voice's; prosody is within range.
// Everything else the old flat settings could get wrong (a model or style
// left behind by a voice change, a format another provider does not offer)
// is unrepresentable or resolved at read time now.
// ---------------------------------------------------------------------------

function findVoice(voices: NormalizedVoice[], ref: VoiceRef | null): NormalizedVoice | undefined {
  if (!ref) return undefined;
  return voices.find((v) => v.providerId === ref.providerId && v.id === ref.voiceId);
}

function pickFallbackVoice(settings: Settings, usable: NormalizedVoice[]) {
  // Prefer a favorite, then the remembered voice for the current language,
  // then anything that speaks the current language.
  for (const favorite of settings.favorites) {
    // Malformed favorites (no colon, empty voice id) can never match a real
    // voice; parseVoiceKey rejects them up front.
    const match = findVoice(usable, parseVoiceKey(favorite));
    if (match) return match;
  }
  const remembered = findVoice(usable, settings.voicesByLanguage[settings.language] ?? null);
  if (remembered) return remembered;
  return usable.find((v) => v.languageCodes.includes(settings.language)) ?? usable[0];
}

/** The engine to use with `voice` when the selection does not say: the one
 *  the user last picked for this provider if the voice offers it, else the
 *  voice's first. */
function preferredModel(settings: Settings, voice: NormalizedVoice): string {
  const last = prefsFor(settings, voice.providerId).lastModel;
  return last !== undefined && voice.models.includes(last) ? last : voice.models[0];
}

/** Pure reconciliation of a settings object against the voice cache. */
export function reconcile(settings: Settings, voices: NormalizedVoice[]): Settings {
  const next: Settings = { ...settings };

  // With an empty cache we cannot validate anything; leave the selection
  // alone (a transient fetch failure must never wipe a working setup).
  if (voices.length === 0) return next;

  const usable = voices.filter((v) => isProviderEnabled(next, v.providerId));
  const current = findVoice(usable, next.selection);
  const voice = current ?? pickFallbackVoice(next, usable);
  if (!voice) {
    next.selection = null;
    return next;
  }

  const provider = getProvider(voice.providerId);
  // Keep the chosen engine while the voice still offers it (voice rosters
  // come from the server and can shrink); a fallback voice starts fresh.
  const model =
    current && next.selection && voice.models.includes(next.selection.model)
      ? next.selection.model
      : preferredModel(next, voice);
  const style = current ? next.selection?.style : undefined;
  const styleOk =
    style !== undefined && provider.supportsStyle(voice, model) && voice.styles?.includes(style);
  const selection: Selection = { providerId: voice.providerId, voiceId: voice.id, model };
  next.selection = styleOk ? { ...selection, style } : selection;

  // Clamp prosody into the provider's ranges for the chosen model.
  const ranges = provider.ranges(model);
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

/**
 * The patch that makes `voice` on `model` the selection, spoken in
 * `language`: the ONE place a selection is written by the user. The style
 * belongs to a voice+engine pair, so it survives only when that pair is
 * unchanged (re-picking the current row); the provider's remembered engine
 * and the per-language voice memory follow.
 */
export function selectVoice(
  current: Settings,
  voice: NormalizedVoice,
  model: string,
  language: string,
): Partial<Settings> {
  const ref: VoiceRef = { providerId: voice.providerId, voiceId: voice.id };
  const previous = current.selection;
  const samePair =
    previous?.providerId === ref.providerId &&
    previous.voiceId === ref.voiceId &&
    previous.model === model;
  const style = samePair ? previous.style : undefined;
  return {
    selection: { ...ref, model, ...(style !== undefined ? { style } : {}) },
    language,
    voicesByLanguage: { ...current.voicesByLanguage, [language]: ref },
    ...withProviderPrefs(current, voice.providerId, { lastModel: model }),
  };
}
