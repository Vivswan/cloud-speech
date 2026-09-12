import type { Settings } from "@/lib/storage";
import { providerList } from "@/providers";
import type { ProviderId } from "@/providers/types";

/** An entry that is merely present does not count: the forks wrote empty-string credential keys at
 *  install time, and the flat-key conversion keeps those as empty records. */
export function configuredProviders(settings: Settings): ProviderId[] {
  return providerList
    .filter((provider) => provider.hasCredentials(settings.perProvider[provider.id]?.credentials))
    .map((provider) => provider.id);
}

/** A provider configured here keeps its entry, whatever the snapshot holds.
 *
 *    provider only the snapshot has configured        -> added whole; favorites are unioned
 *    no provider configured here (a fresh install)    -> the snapshot's selection, prosody and UI preferences come too */
export function mergeSnapshot(
  current: Settings,
  snapshot: Settings,
): { settings: Settings; added: ProviderId[] } {
  const mine = configuredProviders(current);
  const added = configuredProviders(snapshot).filter((id) => !mine.includes(id));
  const fresh = mine.length === 0;
  const perProvider = { ...current.perProvider };
  for (const id of added) perProvider[id] = snapshot.perProvider[id];
  const settings: Settings = {
    ...(fresh ? snapshot : current),
    perProvider,
    favorites: [...new Set([...current.favorites, ...snapshot.favorites])],
  };
  return { settings, added };
}
