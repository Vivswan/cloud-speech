import type { ProviderId } from "@cloud-speech/constants";

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

/** Millions of characters as the count of wan (10,000s) the Chinese pages
 *  spell out: 5M -> 500 wan, 0.5M -> 50 wan. */
export function wan(millions: number): number {
  return Math.round(millions * 100);
}

/** Millions of characters as the count of lakh (100,000s) the Hindi pages
 *  spell out: 5M -> 50 lakh, 0.5M -> 5 lakh. */
export function lakh(millions: number): number {
  return Math.round(millions * 10);
}

/** "$4" -> "$4.00", as the Polly guides print figures. */
export function usdWithCents(usd: string): string {
  return usd.includes(".") ? usd : `${usd}.00`;
}
