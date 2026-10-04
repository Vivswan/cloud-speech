import type { ProviderId, SiteLocaleCode } from "@cloud-speech/constants";

// Pages interpolate the per-provider USD figures, free-tier quantities, and official URLs from here instead of
// restating them; derived prose (cost ratios, per-article estimates) and third-party service links stay on the pages.

/** Formatted USD per 1M characters unless a key says otherwise; pages add their locale's approximation marker. */
export const pricing = {
  polly: {
    officialUrl: "https://aws.amazon.com/polly/pricing/",
    usd: { standard: "$4", neural: "$16", generative: "$30", longForm: "$100" },
  },
  azure: {
    officialUrl: "https://azure.microsoft.com/pricing/details/cognitive-services/speech-services/",
    usd: { neural: "$15-16" },
  },
  google: {
    officialUrl: "https://cloud.google.com/text-to-speech/pricing",
    usd: { standard: "$4", wavenetNeural2: "$16", chirp3Gemini: "$30", studio: "$160" },
  },
  openai: {
    officialUrl: "https://platform.openai.com/docs/pricing",
    usd: { tts1: "$15", tts1Hd: "$30", gpt4oMiniTtsPerMAudioTokens: "$12" },
  },
  custom: {
    officialUrl: "https://docs.litellm.ai/docs/text_to_speech",
    // Local engines are free; gateways bill per their backend.
    usd: {},
  },
} as const satisfies Record<ProviderId, { officialUrl: string; usd: Record<string, string> }>;

export type FreeTier =
  | {
      /** Monthly allowances, in millions of characters. */
      kind: "characters";
      standardM?: number;
      neuralM?: number;
      wavenetM?: number;
      /** The tier lasts only this many months from signup; absent means it renews every month, forever. */
      firstMonths?: number;
    }
  | { kind: "none" }
  | { kind: "provider-dependent" };

export const freeTier = {
  polly: { kind: "characters", standardM: 5, neuralM: 1, firstMonths: 12 },
  azure: { kind: "characters", neuralM: 0.5 },
  google: { kind: "characters", standardM: 4, wavenetM: 1 },
  openai: { kind: "none" },
  custom: { kind: "provider-dependent" },
} as const satisfies Record<ProviderId, FreeTier>;

/** Millions of characters in the locale's compact notation: 5 -> "5M" (en), "50 लाख" (hi), "500万" (zh-cn),
 *  "500萬" (zh-tw). */
export function chars(locale: SiteLocaleCode, millions: number): string {
  return new Intl.NumberFormat(locale, { notation: "compact" }).format(millions * 1_000_000);
}

/** "$4" -> "$4.00", as the Polly guides print figures. */
export function usdWithCents(usd: string): string {
  return usd.includes(".") ? usd : `${usd}.00`;
}
