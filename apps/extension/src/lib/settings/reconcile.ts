import type { Claim } from "@/lib/messaging/slot";
import { getProvider } from "@/providers";
import type { NormalizedVoice, ProsodyRange, ProviderId, TtsProvider } from "@/providers/types";
import {
  isProviderConfigured,
  isProviderEnabled,
  prefsFor,
  withProviderPrefs,
} from "./provider-state";
import {
  readVoiceIssues,
  type Selection,
  type Settings,
  updateSettingsWith,
  type VoiceIssues,
  type VoiceRef,
  voiceIssue,
} from "./storage";
import { parseVoiceKey } from "./voice-key";

// The invariant keeper. With an enabled provider's voice in the cache, it guarantees:
//   selection                      -> a voice the cache has, on an engine it offers, from an enabled provider
//   style                          -> one of that voice's
//   prosody                        -> inside the provider's ranges for that engine
//   a pick the extension made      -> carries no recorded issue while an unflagged voice of the user's language exists
//   a pick the user made           -> theirs to keep, flagged or not
// Outside that:
//   selection on an enabled, configured provider with no cached voice  -> kept, prosody clamped to that provider's ranges
//   anything else while the cache is empty                             -> left as it is; a transient fetch failure must never wipe a working setup
//   cached voices, none from an enabled provider                       -> selection cleared, prosody left as it is

function findVoice(voices: NormalizedVoice[], ref: VoiceRef | null): NormalizedVoice | undefined {
  if (!ref) return undefined;
  return voices.find((v) => v.providerId === ref.providerId && v.id === ref.voiceId);
}

interface Pair {
  voice: NormalizedVoice;
  model: string;
}

/** selectVoice records every user pick in voicesByLanguage and the automatic
 *  fallback never does, so that memory is the provenance. Any language
 *  counts: a pick handed over from a single-provider listing is remembered
 *  under the voice's own language, not necessarily the current one. */
function userPicked(settings: Settings, voice: NormalizedVoice): boolean {
  return Object.values(settings.voicesByLanguage).some(
    (ref) => ref.providerId === voice.providerId && ref.voiceId === voice.id,
  );
}

function preferredModel(settings: Settings, voice: NormalizedVoice): string {
  const last = prefsFor(settings, voice.providerId).lastModel;
  return last !== undefined && voice.models.includes(last) ? last : voice.models[0];
}

/** `exclude` leaves out the engine a flagged selection is moving away from. */
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

/** Preference order; duplicates are harmless, the first hit wins.
 *
 *  favorites                                      -> first
 *  the remembered voice for the current language  -> next
 *  voices speaking the language                   -> `nearProvider`'s first, so a selection that moves stays with its provider when it can
 *  the rest of `pool`                             -> last
 */
function rankedVoices(
  settings: Settings,
  pool: NormalizedVoice[],
  nearProvider?: ProviderId,
): NormalizedVoice[] {
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

/** Unflagged first, so a fetch-time pick never lands on a pair a scan or a
 *  failed read already flagged. With every pair flagged, issues are ignored:
 *  a broken voice shows its error; none shows nothing. */
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

/** Undefined keeps the flagged selection: nothing in the user's language
 *  works, so the recorded error is the best thing to show. */
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

/** The chosen engine stays while the voice still offers it (voice rosters come
 *  from the server and can shrink). Only a selection the extension picked on
 *  its own moves off a flagged pair: the user may deliberately select a
 *  flagged voice to retry it. With no replacement the flagged pair stays. */
function pickCurrentPair(
  settings: Settings,
  usable: NormalizedVoice[],
  issues: VoiceIssues,
  current: NormalizedVoice,
  selection: Selection,
): Pair {
  const model = current.models.includes(selection.model)
    ? selection.model
    : preferredModel(settings, current);
  const kept: Pair = { voice: current, model };
  if (userPicked(settings, current)) return kept;

  const issue = voiceIssue(issues, { providerId: current.providerId, voiceId: current.id, model });
  if (issue === undefined) return kept;

  return pickReplacementPair(settings, usable, issues, kept) ?? kept;
}

/** An enabled, configured provider with no cached voice has an unknown
 *  roster, so a selection on it is kept: the next fetch repairs it, where a
 *  persisted fallback never would. Exported so the popup describes such a
 *  selection from its own fields instead of as "no voice".
 *
 *  fetch failed (an empty answer counts as one), nothing cached from before  -> unknown
 */
export function rosterUnknown(
  settings: Settings,
  voices: NormalizedVoice[],
  providerId: ProviderId,
): boolean {
  return (
    isProviderConfigured(settings, getProvider(providerId)) &&
    !voices.some((v) => v.providerId === providerId)
  );
}

function clamp(value: number, range: ProsodyRange): number {
  return Math.min(Math.max(value, range.min), range.max);
}

/** Pitch and volume gain reach the provider as stored, so their clamp has to
 *  happen here. */
function clampProsody(settings: Settings, provider: TtsProvider, model: string): Settings {
  const ranges = provider.ranges(model);
  return {
    ...settings,
    speed: clamp(settings.speed, ranges.speed),
    pitch: clamp(settings.pitch, ranges.pitch),
    volumeGainDb: clamp(settings.volumeGainDb, ranges.volumeGainDb),
  };
}

export function reconcile(
  settings: Settings,
  voices: NormalizedVoice[],
  issues: VoiceIssues,
): Settings {
  const next: Settings = { ...settings };

  // The selection's own provider and engine bound prosody without any cache.
  if (next.selection && rosterUnknown(next, voices, next.selection.providerId)) {
    return clampProsody(next, getProvider(next.selection.providerId), next.selection.model);
  }

  // With an empty cache there is nothing to pick from; leave the selection
  // alone (a transient fetch failure must never wipe a working setup).
  if (voices.length === 0) return next;

  const usable = voices.filter((v) => isProviderEnabled(next, v.providerId));
  const current = findVoice(usable, next.selection);
  const pair =
    current && next.selection
      ? pickCurrentPair(next, usable, issues, current, next.selection)
      : pickFallbackPair(next, usable, issues);
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

  return clampProsody(next, provider, model);
}

/** One locked fresh-state update: a read-compute-write against a snapshot
 *  would clobber concurrent writes. The issues are read just before, since
 *  the updater is synchronous. A change of the popup's (`update`) lands in
 *  the same write as the reconcile of its result, so a selection is never
 *  stored unreconciled, whatever follows or supersedes it; the caller's
 *  `claim` reaches the write. */
export async function reconcileSettings(
  claim: Claim,
  voices: NormalizedVoice[],
  update?: (current: Settings) => Partial<Settings>,
): Promise<Settings> {
  const issues = await readVoiceIssues();
  return updateSettingsWith(claim, (current) =>
    reconcile({ ...current, ...update?.(current) }, voices, issues),
  );
}

/** The one place a user's selection is written. The style belongs to a
 *  voice+engine pair, so it survives only when that pair is unchanged
 *  (re-picking the current row). */
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
  const selection: Selection = { ...ref, model };
  if (samePair && previous.style !== undefined) selection.style = previous.style;

  return {
    selection,
    language,
    voicesByLanguage: { ...current.voicesByLanguage, [language]: ref },
    ...withProviderPrefs(current, voice.providerId, { lastModel: model }),
  };
}
