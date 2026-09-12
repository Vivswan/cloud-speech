import { getProvider } from "@/providers";
import type { NormalizedVoice, ProviderId } from "@/providers/types";
import { describeFailureWithoutCredentials } from "./errors";
import { credentialsFor, isProviderConfigured, resolveEncoding } from "./provider-state";
import { reconcileSettings } from "./reconcile";
import { NEVER_ABORTS } from "./slot";
import {
  getSettings,
  mergeVoiceIssues,
  type VoiceIssue,
  type VoiceModelRef,
  voicesSessionItem,
} from "./storage";

// User-triggered only, as part of Save & test: successes cost one character
// each, and the user chooses when to spend that (failed requests are
// unbilled). Some access cannot be read from any listing API (Google's Gemini
// voices need the Vertex AI API enabled on the project; region gaps), so the
// scan synthesizes one single-character sample per (provider, engine family).
//
//   a family fails  -> every (voice, engine) pair of it is marked with the failure as the user reads it
//   afterwards      -> the selection is reconciled against the fresh issues: a blind fetch-time pick now known to fail moves to an unflagged voice when one speaks the language, a user pick stays

const PROBE_TEXT = ".";

/** Across all `models` arrays, not only models[0], so every engine of a
 *  dual-engine voice gets judged. */
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
      async ([family, sample]): Promise<{ family: string; issue: VoiceIssue | null }> => {
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
          return { family, issue: null };
        } catch (error) {
          return {
            family,
            issue: await describeFailureWithoutCredentials(error, {
              providerId,
              operation: "scan",
            }),
          };
        }
      },
    ),
  );

  let familiesUnavailable = 0;
  const batch: (VoiceModelRef & { issue: VoiceIssue | null })[] = [];
  for (const { family, issue } of results) {
    if (issue !== null) familiesUnavailable++;
    for (const voice of ownVoices) {
      if (voice.models.includes(family)) {
        batch.push({ providerId: voice.providerId, voiceId: voice.id, model: family, issue });
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
