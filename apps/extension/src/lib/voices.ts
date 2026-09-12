import { providerList } from "@/providers";
import type { NormalizedVoice, ProviderId } from "@/providers/types";
import { credentialsFor, isProviderConfigured } from "./provider-state";
import { reconcileSettings } from "./reconcile";
import { retryTransient } from "./retry";
import { getSettings, voicesSessionItem } from "./storage";

// Overlapping fetches (two Save & tests, popup mount plus validation) must not
// interleave their read-modify-write of the cache. Each queued call re-reads
// settings when it runs, so a provider enabled while an earlier fetch was in
// flight is picked up instead of wiped by a stale snapshot's write.
let fetchChain: Promise<NormalizedVoice[]> = Promise.resolve([]);

export interface PreFetchedVoices {
  providerId: ProviderId;
  voices: NormalizedVoice[];
}

/** One provider failing never drops the others; a failure that outlasts the
 *  retries keeps that provider's last cached voices. `preFetched` lets Save &
 *  test inject the list it already verified, so that result can never be
 *  lost to a transient refetch failure. */
export function fetchAllVoices(preFetched?: PreFetchedVoices): Promise<NormalizedVoice[]> {
  const run = () => fetchAllVoicesNow(preFetched);
  const next = fetchChain.then(run, run);
  fetchChain = next.catch(() => []);
  return next;
}

async function fetchAllVoicesNow(preFetched?: PreFetchedVoices): Promise<NormalizedVoice[]> {
  const settings = await getSettings();
  const cached = await voicesSessionItem.getValue();

  const active = providerList.filter((p) => isProviderConfigured(settings, p));

  const results = await Promise.allSettled(
    active.map((p) =>
      preFetched && preFetched.providerId === p.id
        ? Promise.resolve(preFetched.voices)
        : retryTransient(() => p.fetchVoices(credentialsFor(settings, p.id)), undefined, p),
    ),
  );

  const merged: NormalizedVoice[] = [];
  for (let i = 0; i < active.length; i++) {
    const provider = active[i];
    const result = results[i];
    if (!provider || !result) continue;

    if (result.status === "fulfilled") {
      merged.push(...result.value);
    } else {
      const kept = cached.filter((v) => v.providerId === provider.id);
      const outcome =
        kept.length > 0 ? `keeping ${kept.length} cached voice(s)` : "nothing cached for it";
      console.warn(`Voice fetch failed for ${provider.id}; ${outcome}`, result.reason);
      merged.push(...kept);
    }
  }

  await voicesSessionItem.setValue(merged);
  await reconcileSettings(merged);
  return merged;
}
