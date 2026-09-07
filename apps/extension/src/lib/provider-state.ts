import { getProvider } from "@/providers";
import type { ProviderId, TtsProvider } from "@/providers/types";
import type { ProviderPrefs, Settings } from "./storage";

// ---------------------------------------------------------------------------
// The three states a provider can be in, each with one name. Enabled is the
// user's switch; configured adds "every required credential field is filled"
// (the provider can be called); connected adds "those credentials passed
// Save & test" (the UI may call it working). All read from the provider's
// own settings entry; a provider the user never touched reads as defaults.
// ---------------------------------------------------------------------------

const UNTOUCHED: ProviderPrefs = { credentials: {}, verified: false, enabled: false };

/** The provider's stored entry, or the defaults when the user never saved
 *  one. Never mutate the result: it may be the shared defaults object. */
export function prefsFor(settings: Settings, id: ProviderId): ProviderPrefs {
  return settings.perProvider[id] ?? UNTOUCHED;
}

/** The `perProvider` patch that changes one provider's entry: the ONE way to
 *  write a provider's fields, so an update can never drop a sibling entry. */
export function withProviderPrefs(
  settings: Settings,
  id: ProviderId,
  patch: Partial<ProviderPrefs>,
): Pick<Settings, "perProvider"> {
  return {
    perProvider: { ...settings.perProvider, [id]: { ...prefsFor(settings, id), ...patch } },
  };
}

export function isProviderEnabled(settings: Settings, id: ProviderId): boolean {
  return prefsFor(settings, id).enabled;
}

export function isProviderConfigured(settings: Settings, provider: TtsProvider): boolean {
  const prefs = prefsFor(settings, provider.id);
  return prefs.enabled && provider.hasCredentials(prefs.credentials);
}

/** `verified` implies complete credentials (the settings parse guarantees
 *  it), so connected needs no credential check of its own. */
export function isProviderConnected(settings: Settings, id: ProviderId): boolean {
  const prefs = prefsFor(settings, id);
  return prefs.enabled && prefs.verified;
}

/** The stored credentials; empty when the user never saved any. */
export function credentialsFor(settings: Settings, id: ProviderId): Record<string, string> {
  return prefsFor(settings, id).credentials;
}

export type EncodingPurpose = "readAloud" | "download";

/** The format id a synthesis for `purpose` uses with this provider: the
 *  user's choice for the provider when the provider still offers it for that
 *  purpose, else the provider's first format for it. Resolved at read time,
 *  so a stale choice (a format the provider dropped) never needs repairing
 *  in storage. */
export function resolveEncoding(
  settings: Settings,
  provider: TtsProvider,
  purpose: EncodingPurpose,
): string {
  const prefs = prefsFor(settings, provider.id);
  const wanted = purpose === "readAloud" ? prefs.readAloudEncoding : prefs.downloadEncoding;
  const offered = provider.audioFormats.filter((format) =>
    purpose === "readAloud" ? format.forReadAloud : format.forDownload,
  );
  const [first = provider.audioFormats[0]] = offered;
  return offered.find((format) => format.id === wanted)?.id ?? first.id;
}

/** `resolveEncoding` for the selected voice's provider; null with no voice
 *  selected (there is no provider to resolve against). */
export function selectionEncoding(settings: Settings, purpose: EncodingPurpose): string | null {
  const selection = settings.selection;
  return selection ? resolveEncoding(settings, getProvider(selection.providerId), purpose) : null;
}
