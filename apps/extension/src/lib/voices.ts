import { providerList } from "@/providers";
import type { NormalizedVoice, ProviderId } from "@/providers/types";
import { reconcileSettings } from "./reconcile";
import { getSettings, voicesSessionItem } from "./storage";

// Overlapping fetches (two Save & tests, popup mount + validation) must not
// interleave their read-modify-write of the cache: serialized, each call
// re-reads settings when it actually runs, so a provider enabled while an
// earlier fetch was in flight is picked up by its own queued fetch instead of
// being wiped by a stale snapshot's write.
let fetchChain: Promise<NormalizedVoice[]> = Promise.resolve([]);

export interface PreFetchedVoices {
  providerId: ProviderId;
  voices: NormalizedVoice[];
}

/**
 * Fetch voices from every enabled, credentialed provider.
 * One provider failing never drops the others, and a transient failure keeps
 * that provider's last-good cached voices instead of wiping them.
 * `preFetched` lets a caller that ALREADY holds a verified fresh list (Save &
 * test) inject it instead of refetching; the verified result can then never
 * be lost to a transient refetch failure.
 */
export function fetchAllVoices(preFetched?: PreFetchedVoices): Promise<NormalizedVoice[]> {
  const run = () => fetchAllVoicesNow(preFetched);
  const next = fetchChain.then(run, run);
  fetchChain = next.catch(() => []);
  return next;
}

async function fetchAllVoicesNow(preFetched?: PreFetchedVoices): Promise<NormalizedVoice[]> {
  const settings = await getSettings();
  const cached = await voicesSessionItem.getValue();

  const active = providerList.filter(
    (p) => settings.enabledProviders[p.id] && p.hasCredentials(settings.credentials[p.id]),
  );

  const results = await Promise.allSettled(
    active.map((p) =>
      preFetched && preFetched.providerId === p.id
        ? Promise.resolve(preFetched.voices)
        : p.fetchVoices(settings.credentials[p.id] ?? {}),
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
      console.warn(`Voice fetch failed for ${provider.id}; keeping cached voices`, result.reason);
      merged.push(...cached.filter((v) => v.providerId === provider.id));
    }
  }

  await voicesSessionItem.setValue(merged);
  await reconcileSettings(merged);
  return merged;
}
