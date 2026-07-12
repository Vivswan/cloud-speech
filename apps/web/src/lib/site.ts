// Shared site-wide constants: the Chrome Web Store link and provider metadata
// rendered by the nav, footer, homepage, pricing, and troubleshooting pages.

// TODO: This is the old Polly for Chrome listing ID. Swap it for the unified
// Cloud Speech for Chrome listing ID once that listing is published.
export const chromeWebStoreUrl =
  "https://chromewebstore.google.com/detail/kdcbeehimalgmeoeajnflggejlemclnn";

export type ProviderId = "polly" | "azure" | "google" | "openai";

export interface Provider {
  id: ProviderId;
  name: string;
  /** Tailwind class for the provider's dot color. */
  dot: string;
  /** Tailwind class for the tinted ring behind the dot on the homepage cards. */
  ring: string;
  /** One-line summary shown on the homepage setup-guide cards. */
  blurb: string;
}

export const providers: Provider[] = [
  {
    id: "polly",
    name: "Amazon Polly",
    dot: "bg-polly",
    ring: "bg-polly/10",
    blurb:
      "Standard, Neural, Generative, and Long-form voices. Free tier: 5M characters/month (standard) for the first 12 months.",
  },
  {
    id: "azure",
    name: "Azure Speech",
    dot: "bg-azure",
    ring: "bg-azure/10",
    blurb:
      "High-quality neural voices in many languages. Free tier: 0.5M neural characters/month, forever.",
  },
  {
    id: "google",
    name: "Google Cloud TTS",
    dot: "bg-google",
    ring: "bg-google/10",
    blurb:
      "Standard, WaveNet, Neural2, and Chirp HD voices. Free tier: 1M WaveNet + 4M standard characters/month.",
  },
  {
    id: "openai",
    name: "OpenAI",
    dot: "bg-openai",
    ring: "bg-openai/10",
    blurb:
      "Expressive tts-1, tts-1-hd, and gpt-4o-mini-tts voices. Simplest setup: one API key, no region. Pay as you go.",
  },
];
