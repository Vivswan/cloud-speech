import type { ProviderId, TtsProvider } from "@/providers/types";
import type { Settings } from "./storage";

// ---------------------------------------------------------------------------
// The three states a provider can be in, each with one name. Enabled is the
// user's switch; configured adds "every required credential field is filled"
// (the provider can be called); connected adds "those credentials passed
// Save & test" (the UI may call it working).
// ---------------------------------------------------------------------------

export function isProviderEnabled(settings: Settings, id: ProviderId): boolean {
  return settings.enabledProviders[id] === true;
}

export function isProviderConfigured(settings: Settings, provider: TtsProvider): boolean {
  return (
    isProviderEnabled(settings, provider.id) &&
    provider.hasCredentials(settings.credentials[provider.id])
  );
}

export function isProviderConnected(settings: Settings, id: ProviderId): boolean {
  return isProviderEnabled(settings, id) && settings.credentialsValid[id] === true;
}

/** The stored credentials; empty when the user never saved any. */
export function credentialsFor(settings: Settings, id: ProviderId): Record<string, string> {
  return settings.credentials[id] ?? {};
}
