import type { ProviderId } from "@cloud-speech/constants";
import { pricing } from "./pricing";
import { type Provider, providers } from "./site";

// The pricing table's shape, shared by the four locale copies of pricing.astro: which cost lines each provider
// shows, in what order, and which `pricing` figure a line prints. A page supplies the words only.

/** A line named after a `pricing[id].usd` key prints that figure; any other line prices itself in prose. */
export const PRICING_LINES = {
  polly: ["standard", "neural", "generative", "longForm"],
  azure: ["neural", "hdCustom"],
  google: ["standard", "wavenetNeural2", "chirpHd", "chirp3Gemini", "studio"],
  openai: ["tts1", "tts1Hd", "gpt4oMiniTtsPerMAudioTokens"],
  custom: ["local", "gateway"],
} as const satisfies Record<ProviderId, readonly string[]>;

type LineId<P extends ProviderId> = (typeof PRICING_LINES)[P][number];
type UsdKey<P extends ProviderId> = keyof (typeof pricing)[P]["usd"];

/** The figure arrives as the wrapper's argument so the page adds only its locale's approximation marker;
 *  without a wrapper the figure prints bare. */
export type PriceLineStrings<P extends ProviderId, L extends LineId<P>> =
  L extends UsdKey<P>
    ? { label: string; price?: (usd: string) => string }
    : { label: string; price: string };

export type PricingStrings = {
  [P in ProviderId]: {
    freeTier: string;
    officialLabel: string;
    lines: { [L in LineId<P>]: PriceLineStrings<P, L> };
  };
};

export interface CostLine {
  label: string;
  price: string;
}

export interface PricingRow extends Provider {
  freeTier: string;
  costs: CostLine[];
  officialUrl: string;
  officialLabel: string;
}

function costLines<P extends ProviderId>(id: P, lines: PricingStrings[P]["lines"]): CostLine[] {
  const usd: Partial<Record<string, string>> = pricing[id].usd;
  return PRICING_LINES[id].map((line: LineId<P>): CostLine => {
    const entry: { label: string; price?: string | ((usd: string) => string) } = lines[line];
    if (typeof entry.price === "string") return { label: entry.label, price: entry.price };
    const figure = usd[line];
    // PriceLineStrings admits a wrapper or no price only for lines named after a usd key.
    if (figure === undefined) throw new Error(`pricing.${id}.usd has no "${line}" figure`);
    return { label: entry.label, price: entry.price ? entry.price(figure) : figure };
  });
}

export function pricingRows(strings: PricingStrings): PricingRow[] {
  return providers.map((provider) => {
    const { freeTier, officialLabel, lines } = strings[provider.id];
    return {
      ...provider,
      freeTier,
      costs: costLines(provider.id, lines),
      officialUrl: pricing[provider.id].officialUrl,
      officialLabel,
    };
  });
}
