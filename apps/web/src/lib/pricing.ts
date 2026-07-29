import type { ProviderId } from "@cloud-speech/constants";

// Provider pricing facts, written down once: the USD figures, the free-tier
// quantities, and the official pricing URLs. The locale pricing pages, the
// setup guides, and the homepage blurbs (lib/site.ts and the localized
// index pages) interpolate these into their own translated prose; no page
// restates a number or URL.

/** Formatted USD figures per 1M characters (except where a key says
 *  otherwise). Pages add their own locale's approximation marker and
 *  translated row labels. */
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
    // gpt-4o-mini-tts is token-billed: the figure is per 1M AUDIO tokens.
    usd: { tts1: "$15", tts1Hd: "$30", gpt4oMiniTtsPerMAudioTokens: "$12" },
  },
  custom: {
    officialUrl: "https://docs.litellm.ai/docs/text_to_speech",
    // Local engines are free; gateways bill per their backend.
    usd: {},
  },
} as const satisfies Record<ProviderId, { officialUrl: string; usd: Record<string, string> }>;

/** A provider's free tier, as a closed set of shapes: having no free tier
 *  ("none") or one that depends on the user's own server
 *  ("provider-dependent") is declared data, not prose, so a new provider is
 *  forced to state which case it is. */
export type FreeTier =
  | {
      /** Monthly allowances, in millions of characters. */
      kind: "characters";
      standardM?: number;
      neuralM?: number;
      wavenetM?: number;
      /** The tier covers only the first N months after signup; absent means
       *  it renews every month, forever. */
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

/** A USD figure rendered with explicit cents, as the Polly guides print it:
 *  "$4" -> "$4.00"; a figure that already carries cents stays as is. */
export function usdWithCents(usd: string): string {
  return usd.includes(".") ? usd : `${usd}.00`;
}
