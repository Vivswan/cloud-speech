import { getProvider } from "@/providers";
import type { NormalizedVoice, ProviderId } from "@/providers/types";
import { isProviderEnabled, prefsFor, withProviderPrefs } from "./provider-state";
import {
  type Selection,
  type Settings,
  updateSettingsWith,
  type VoiceIssues,
  type VoiceRef,
  voiceIssue,
} from "./storage";
import { parseVoiceKey } from "./voice-key";

// ---------------------------------------------------------------------------
// reconcileSettings: the central invariant keeper. Runs after startup, voice
// fetch, credential changes, provider enable/disable, and voice selection.
// Guarantees that whatever is persisted is actually usable: the selection
// names a voice the cache has on an engine it offers, from an enabled
// provider, with no recorded issue while an unflagged voice of the user's
// language exists; its style is one of that voice's; prosody is within range.
// Everything else the old flat settings could get wrong (a model or style
// left behind by a voice change, a format another provider does not offer)
// is unrepresentable or resolved at read time now.
// ---------------------------------------------------------------------------

function findVoice(voices: NormalizedVoice[], ref: VoiceRef | null): NormalizedVoice | undefined {
  if (!ref) return undefined;
  return voices.find((v) => v.providerId === ref.providerId && v.id === ref.voiceId);
}

interface Pair {
  voice: NormalizedVoice;
  model: string;
}

/** The engine the user last picked for this provider if the voice offers it,
 *  else the voice's first. */
function preferredModel(settings: Settings, voice: NormalizedVoice): string {
  const last = prefsFor(settings, voice.providerId).lastModel;
  return last !== undefined && voice.models.includes(last) ? last : voice.models[0];
}

/** `voice` on an engine without a recorded issue (the preferred one when it
 *  qualifies), or undefined when every engine is flagged. `exclude` leaves
 *  out the engine a flagged selection is moving away from. */
function unflaggedPair(
  settings: Settings,
  issues: VoiceIssues,
  voice: NormalizedVoice,
  exclude?: string,
): Pair | undefined {
  const preferred = preferredModel(settings, voice);
  const model = [preferred, ...voice.models].find(
    (candidate) =>
      candidate !== exclude &&
      voiceIssue(issues, { providerId: voice.providerId, voiceId: voice.id, model: candidate }) ===
        undefined,
  );
  return model === undefined ? undefined : { voice, model };
}

/** `pool` in preference order: favorites, the remembered voice for the
 *  current language, voices speaking that language (those of `nearProvider`
 *  first, so a selection that moves stays with its provider when it can),
 *  then the rest of the pool. Duplicates are harmless: the first hit wins. */
function rankedVoices(
  settings: Settings,
  pool: NormalizedVoice[],
  nearProvider?: ProviderId,
): NormalizedVoice[] {
  // Malformed favorites (no colon, empty voice id) can never match a real
  // voice; parseVoiceKey rejects them up front.
  const favorites = settings.favorites.flatMap((favorite) => {
    const match = findVoice(pool, parseVoiceKey(favorite));
    return match ? [match] : [];
  });
  const remembered = findVoice(pool, settings.voicesByLanguage[settings.language] ?? null);
  const speaking = pool.filter((v) => v.languageCodes.includes(settings.language));
  return [
    ...favorites,
    ...(remembered ? [remembered] : []),
    ...speaking.filter((v) => v.providerId === nearProvider),
    ...speaking,
    ...pool,
  ];
}

/** The first ranked voice with an unflagged engine, excluding `skip`. */
function firstUnflagged(
  settings: Settings,
  issues: VoiceIssues,
  ranked: NormalizedVoice[],
  skip?: NormalizedVoice,
): Pair | undefined {
  for (const voice of ranked) {
    if (voice === skip) continue;
    const pair = unflaggedPair(settings, issues, voice);
    if (pair) return pair;
  }
  return undefined;
}

/** The pair to select when nothing is selected: the first ranked voice with
 *  an unflagged engine, so a fetch-time pick never lands on a pair a scan
 *  or a failed read already flagged. With every pair flagged the pick
 *  ignores issues (a broken voice shows its error; none shows nothing). */
function pickFallbackPair(
  settings: Settings,
  usable: NormalizedVoice[],
  issues: VoiceIssues,
): Pair | undefined {
  const ranked = rankedVoices(settings, usable);
  const unflagged = firstUnflagged(settings, issues, ranked);
  if (unflagged) return unflagged;
  const voice = ranked[0];
  return voice ? { voice, model: preferredModel(settings, voice) } : undefined;
}

/** Where a flagged selection moves: another engine of the same voice, then
 *  the ranked voices of the current language (its own provider first),
 *  unflagged only. Undefined keeps the flagged selection: nothing in the
 *  user's language works, so the recorded error is the best thing to show. */
function pickReplacementPair(
  settings: Settings,
  usable: NormalizedVoice[],
  issues: VoiceIssues,
  flagged: Pair,
): Pair | undefined {
  const sameVoice = unflaggedPair(settings, issues, flagged.voice, flagged.model);
  if (sameVoice) return sameVoice;
  const speaking = usable.filter((v) => v.languageCodes.includes(settings.language));
  const ranked = rankedVoices(settings, speaking, flagged.voice.providerId);
  return firstUnflagged(settings, issues, ranked, flagged.voice);
}

/** Pure reconciliation of a settings object against the voice cache and the
 *  recorded voice issues. */
export function reconcile(
  settings: Settings,
  voices: NormalizedVoice[],
  issues: VoiceIssues,
): Settings {
  const next: Settings = { ...settings };

  // With an empty cache we cannot validate anything; leave the selection
  // alone (a transient fetch failure must never wipe a working setup).
  if (voices.length === 0) return next;

  const usable = voices.filter((v) => isProviderEnabled(next, v.providerId));
  const current = findVoice(usable, next.selection);
  let pair: Pair | undefined;
  if (current && next.selection) {
    // Keep the chosen engine while the voice still offers it (voice rosters
    // come from the server and can shrink).
    const kept: Pair = {
      voice: current,
      model: current.models.includes(next.selection.model)
        ? next.selection.model
        : preferredModel(next, current),
    };
    const flagged =
      voiceIssue(issues, {
        providerId: current.providerId,
        voiceId: current.id,
        model: kept.model,
      }) !== undefined;
    pair = flagged ? (pickReplacementPair(next, usable, issues, kept) ?? kept) : kept;
  } else {
    pair = pickFallbackPair(next, usable, issues);
  }
  if (!pair) {
    next.selection = null;
    return next;
  }

  const { voice, model } = pair;
  const provider = getProvider(voice.providerId);
  // A style belongs to the voice; a fallback voice starts fresh.
  const style = voice === current ? next.selection?.style : undefined;
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
export function reconcileSettings(
  voices: NormalizedVoice[],
  issues: VoiceIssues,
): Promise<Settings> {
  return updateSettingsWith((current) => reconcile(current, voices, issues));
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
