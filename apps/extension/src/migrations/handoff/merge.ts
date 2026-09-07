import type { Settings } from "@/lib/storage";
import { providerList } from "@/providers";
import type { ProviderId } from "@/providers/types";

/** The providers whose credentials are complete. An entry that is merely
 *  PRESENT does not count: the forks wrote empty-string credential keys at
 *  install time, and the flat-key conversion keeps those as empty records, so
 *  an install that never configured its provider still has one. */
export function configuredProviders(settings: Settings): ProviderId[] {
  return providerList
    .filter((provider) => provider.hasCredentials(settings.perProvider[provider.id]?.credentials))
    .map((provider) => provider.id);
}

/** Fold one fork install's settings into this install's.
 *  - A provider configured here keeps its entry, whatever the snapshot holds.
 *  - A provider only the snapshot has configured is added whole (its entry:
 *    credentials, verification, enable switch, formats), and favorites are
 *    unioned.
 *  - An install with no provider configured is a fresh one: it takes the
 *    snapshot's voice selection, prosody and UI preferences as well. */
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
