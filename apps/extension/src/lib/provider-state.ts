import { getProvider } from "@/providers";
import type { ProviderId, TtsProvider } from "@/providers/types";
import type { ProviderPrefs, Settings } from "./storage";

// The three states of a provider, each with one name; a provider the user
// never touched reads as defaults.
//   enabled     -> the user's switch
//   configured  -> enabled, and every required credential field is filled (the provider can be called)
//   connected   -> enabled, and those credentials passed Save & test (the UI may call it working)

const UNTOUCHED: ProviderPrefs = { credentials: {}, verified: false, enabled: false };

/** Never mutate the result: it may be the shared defaults object. */
export function prefsFor(settings: Settings, id: ProviderId): ProviderPrefs {
  return settings.perProvider[id] ?? UNTOUCHED;
}

/** The ONE way to write a provider's fields, so an update can never drop a
 *  sibling entry. */
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

export function credentialsFor(settings: Settings, id: ProviderId): Record<string, string> {
  return prefsFor(settings, id).credentials;
}

export type EncodingPurpose = "readAloud" | "download";

/** Resolved at read time, so a stale choice (a format the provider dropped)
 *  never needs repairing in storage. */
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

export function selectionEncoding(settings: Settings, purpose: EncodingPurpose): string | null {
  const selection = settings.selection;
  return selection ? resolveEncoding(settings, getProvider(selection.providerId), purpose) : null;
}
