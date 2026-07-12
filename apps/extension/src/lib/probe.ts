import { getProvider, providerList } from "@/providers";
import type { NormalizedVoice } from "@/providers/types";
import { getSettings, mergeVoiceIssues, voiceIssueKey, voicesSessionItem } from "./storage";

// ---------------------------------------------------------------------------
// Availability scan — USER-TRIGGERED only (runs as part of Save & test; each
// provider's access rules differ).
// Some access can't be read from any free listing API (Google's Gemini voices
// need the Vertex AI API enabled on the project, region gaps, etc.), so the
// scan synthesizes ONE single-character sample per (provider, engine family)
// and marks every (voice, engine) pair of a failing family with the
// provider's error. Dual-engine voices are judged per engine — a voice can
// work on neural and fail on standard.
// Failed requests are unbilled; successes cost one character each — the user
// chooses when (and whether) to spend that.
// ---------------------------------------------------------------------------

const PROBE_TEXT = ".";

/** One sample voice per distinct engine family, across ALL models arrays —
 *  not just models[0], so every engine of a dual-engine voice gets judged. */
function familySamples(voices: NormalizedVoice[]): Map<string, NormalizedVoice> {
  const samples = new Map<string, NormalizedVoice>();
  for (const voice of voices) {
    for (const family of voice.models.length > 0 ? voice.models : ["default"]) {
      if (!samples.has(family)) samples.set(family, voice);
    }
  }
  return samples;
}

export interface ScanResult {
  familiesChecked: number;
  familiesUnavailable: number;
}

export async function scanVoiceAvailability(providerId: string): Promise<ScanResult> {
  const settings = await getSettings();
  const voices = await voicesSessionItem.getValue();

  const active = providerList.filter(
    (p) =>
      p.id === providerId &&
      settings.enabledProviders[p.id] &&
      p.hasCredentials(settings.credentials[p.id]),
  );

  let familiesChecked = 0;
  let familiesUnavailable = 0;
  const batch: Record<string, string | null> = {};

  await Promise.all(
    active.map(async (provider) => {
      const credentials = settings.credentials[provider.id] ?? {};
      // Playback parity: probe with the encoding a real read would use, so a
      // family can't pass the scan with a format playback never sends.
      const readAloudIds = provider.audioFormats.filter((f) => f.forReadAloud).map((f) => f.id);
      const encoding = readAloudIds.includes(settings.readAloudEncoding)
        ? settings.readAloudEncoding
        : (readAloudIds[0] ?? "MP3");
      const ownVoices = voices.filter((v) => v.providerId === provider.id);
      const samples = familySamples(ownVoices);

      const results = await Promise.allSettled(
        [...samples].map(async ([family, sample]) => {
          await getProvider(provider.id).synthesize({
            text: PROBE_TEXT,
            voiceId: sample.id,
            model: family,
            language: sample.languageCodes[0],
            encoding,
            speed: 1,
            pitch: 0,
            volumeGainDb: 0,
            credentials,
          });
          return family;
        }),
      );

      const families = [...samples.keys()];
      results.forEach((result, i) => {
        const family = families[i];
        if (family === undefined) return;
        familiesChecked++;
        const reason = result.status === "rejected" ? String(result.reason) : null;
        if (reason !== null) familiesUnavailable++;
        for (const voice of ownVoices) {
          if (
            voice.models.includes(family) ||
            (voice.models.length === 0 && family === "default")
          ) {
            batch[voiceIssueKey(voice.providerId, voice.id, family)] = reason;
          }
        }
      });
    }),
  );

  await mergeVoiceIssues(batch);
  return { familiesChecked, familiesUnavailable };
}
