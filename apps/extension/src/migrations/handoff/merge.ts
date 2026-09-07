import type { Settings } from "@/lib/storage";
import type { ProviderId } from "@/providers/types";

/** Fold one fork install's settings into this install's. The ONE place that
 *  knows which settings fields belong to a provider.
 *  - A provider configured here keeps its keys, whatever the snapshot holds.
 *  - A provider only the snapshot has is added whole (credentials, validity,
 *    enabled flag), and favorites are unioned.
 *  - An install with no credentials at all is a fresh one: it takes the
 *    snapshot's voice selection, prosody and UI preferences as well. */
export function mergeSnapshot(
  current: Settings,
  snapshot: Settings,
): { settings: Settings; added: ProviderId[] } {
  const added = (Object.keys(snapshot.credentials) as ProviderId[]).filter(
    (id) => current.credentials[id] === undefined,
  );
  const fresh = Object.keys(current.credentials).length === 0;
  const settings: Settings = {
    ...(fresh ? snapshot : current),
    credentials: { ...current.credentials },
    credentialsValid: { ...current.credentialsValid },
    enabledProviders: { ...current.enabledProviders },
    favorites: [...new Set([...current.favorites, ...snapshot.favorites])],
  };
  for (const id of added) {
    settings.credentials[id] = snapshot.credentials[id];
    settings.credentialsValid[id] = snapshot.credentialsValid[id] ?? false;
    settings.enabledProviders[id] = snapshot.enabledProviders[id] ?? false;
  }
  return { settings, added };
}
