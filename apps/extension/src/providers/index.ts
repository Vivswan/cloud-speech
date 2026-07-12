import { azure } from "./azure";
import { custom } from "./custom";
import { google } from "./google";
import { openai } from "./openai";
import { polly } from "./polly";
import type { ProviderId, TtsProvider } from "./types";

// The registry. Adding a provider = one new file + one line here.
export const providers: Record<ProviderId, TtsProvider> = {
  polly,
  azure,
  google,
  openai,
  custom,
};

export const providerList: TtsProvider[] = Object.values(providers);

export function getProvider(id: ProviderId): TtsProvider {
  return providers[id];
}

export * from "./types";
