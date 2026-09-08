import { getProvider } from "@/providers";
import type { NormalizedVoice, ProviderId } from "@/providers/types";
import { credentialsFor, isProviderConfigured, resolveEncoding } from "./provider-state";
import { reconcileSettings } from "./reconcile";
import { NEVER_ABORTS } from "./slot";
import { getSettings, mergeVoiceIssues, type VoiceModelRef, voicesSessionItem } from "./storage";

// ---------------------------------------------------------------------------
// Availability scan: USER-TRIGGERED only (runs as part of Save & test; each
// provider's access rules differ).
// Some access can't be read from any free listing API (Google's Gemini voices
// need the Vertex AI API enabled on the project, region gaps, etc.), so the
// scan synthesizes ONE single-character sample per (provider, engine family)
// and marks every (voice, engine) pair of a failing family with the
// provider's error. Dual-engine voices are judged per engine: a voice can
// work on neural and fail on standard.
// Failed requests are unbilled; successes cost one character each, and the
// user chooses when (and whether) to spend that.
// The scan is the moment the extension learns what the account can use, so
// the selection is reconciled against the fresh issues right after: a voice
// the fetch-time fallback picked blind must not stay selected once it is
// known to fail (a voice the user picked stays; reconcile tells them apart).
// ---------------------------------------------------------------------------

const PROBE_TEXT = ".";

/** One sample voice per distinct engine family, across ALL models arrays
 *  (not only models[0]), so every engine of a dual-engine voice gets judged. */
function familySamples(voices: NormalizedVoice[]): Map<string, NormalizedVoice> {
  const samples = new Map<string, NormalizedVoice>();
  for (const voice of voices) {
    for (const family of voice.models) {
      if (!samples.has(family)) samples.set(family, voice);
    }
  }
  return samples;
}

export interface ScanResult {
  familiesChecked: number;
  familiesUnavailable: number;
}

export async function scanVoiceAvailability(providerId: ProviderId): Promise<ScanResult> {
  const settings = await getSettings();
  const provider = getProvider(providerId);
  if (!isProviderConfigured(settings, provider)) {
    return { familiesChecked: 0, familiesUnavailable: 0 };
  }

  const credentials = credentialsFor(settings, providerId);
  // Playback parity: probe with the encoding a real read would use, so a
  // family can't pass the scan with a format playback never sends.
  const encoding = resolveEncoding(settings, provider, "readAloud");
  const voices = await voicesSessionItem.getValue();
  const ownVoices = voices.filter((v) => v.providerId === providerId);
  const samples = familySamples(ownVoices);

  const results = await Promise.all(
    [...samples].map(
      async ([family, sample]): Promise<{ family: string; reason: string | null }> => {
        try {
          await provider.synthesize({
            text: PROBE_TEXT,
            voiceId: sample.id,
            model: family,
            language: sample.languageCodes[0],
            encoding,
            speed: 1,
            pitch: 0,
            volumeGainDb: 0,
            credentials,
            // User-triggered and run to completion; nothing supersedes a scan.
            signal: NEVER_ABORTS,
          });
          return { family, reason: null };
        } catch (error) {
          return { family, reason: String(error) };
        }
      },
    ),
  );

  let familiesUnavailable = 0;
  const batch: (VoiceModelRef & { reason: string | null })[] = [];
  for (const { family, reason } of results) {
    if (reason !== null) familiesUnavailable++;
    for (const voice of ownVoices) {
      if (voice.models.includes(family)) {
        batch.push({ providerId: voice.providerId, voiceId: voice.id, model: family, reason });
      }
    }
  }

  await mergeVoiceIssues(batch);
  // The roster may have grown during the round trips (another provider's
  // Save & test); reconcile against the current one, or a fresh pick from
  // that provider would read as vanished and be replaced.
  await reconcileSettings(await voicesSessionItem.getValue());
  return { familiesChecked: results.length, familiesUnavailable };
}
