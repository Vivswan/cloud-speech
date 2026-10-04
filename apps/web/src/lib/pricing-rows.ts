import type { ProviderId } from "@cloud-speech/constants";
import { pricing } from "./pricing";
import { type Provider, providers } from "./site";

/** Cost lines priced in prose; every other line is a `pricing[id].usd` figure. */
const PROSE_LINES = {
  polly: [],
  azure: ["hdCustom"],
  google: ["chirpHd"],
  openai: [],
  custom: ["local", "gateway"],
} as const satisfies Record<ProviderId, readonly string[]>;

type FigureLine<P extends ProviderId> = keyof (typeof pricing)[P]["usd"] & string;
type ProseLine<P extends ProviderId> = (typeof PROSE_LINES)[P][number];
type LineId<P extends ProviderId> = FigureLine<P> | ProseLine<P>;

/** Display order per provider. */
export const PRICING_LINES: { readonly [P in ProviderId]: readonly LineId<P>[] } = {
  polly: ["standard", "neural", "generative", "longForm"],
  azure: ["neural", "hdCustom"],
  google: ["standard", "wavenetNeural2", "chirpHd", "chirp3Gemini", "studio"],
  openai: ["tts1", "tts1Hd", "gpt4oMiniTtsPerMAudioTokens"],
  custom: ["local", "gateway"],
};

/** The figure arrives as the wrapper's argument so the page adds only its locale's approximation marker;
 *  without a wrapper the figure prints bare. */
interface FigureLineStrings {
  label: string;
  price?: (usd: string) => string;
}

interface ProseLineStrings {
  label: string;
  price: string;
}

type FigureLines<P extends ProviderId> = { [L in FigureLine<P>]: FigureLineStrings };
type ProseLines<P extends ProviderId> = { [L in ProseLine<P>]: ProseLineStrings };
type Figures = { [P in ProviderId]: { readonly [L in FigureLine<P>]: string } };

export type PricingStrings = {
  [P in ProviderId]: {
    freeTier: string;
    officialLabel: string;
    lines: FigureLines<P> & ProseLines<P>;
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

// Every per-provider value arrives as the mapped type indexed by P, so one generic body serves a union-typed
// caller and still sees the single provider's keys.
function costLines<P extends ProviderId>(
  id: P,
  usd: Figures[P],
  lines: PricingStrings[P]["lines"],
): CostLine[] {
  const figureLines: FigureLines<P> = lines;
  const proseLines: ProseLines<P> = lines;
  const hasFigure = (line: LineId<P>): line is FigureLine<P> => line in usd;
  return PRICING_LINES[id].map((line): CostLine => {
    if (hasFigure(line)) {
      const entry = figureLines[line];
      const figure = usd[line];
      return { label: entry.label, price: entry.price ? entry.price(figure) : figure };
    }
    const entry = proseLines[line];
    return { label: entry.label, price: entry.price };
  });
}

export function pricingRows(strings: PricingStrings): PricingRow[] {
  return providers.map((provider) => {
    const { freeTier, officialLabel, lines } = strings[provider.id];
    return {
      ...provider,
      freeTier,
      costs: costLines(provider.id, pricing[provider.id].usd, lines),
      officialUrl: pricing[provider.id].officialUrl,
      officialLabel,
    };
  });
}
