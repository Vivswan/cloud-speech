import {
  PROVIDER_IDS,
  PROVIDER_NAMES,
  type ProviderId,
  SHORTCUTS,
  shortcutDisplay,
} from "@cloud-speech/constants";

// Shared site-wide constants. Cross-app identities (store links, GitHub
// URLs, provider roster/names) come from the shared @cloud-speech/constants
// package, the single source of truth also used by the extension; this
// module adds the website-only presentation metadata.

export {
  chromeListing,
  firefoxListing,
  GITHUB_ISSUES_URL,
  GITHUB_REPO_URL,
  PROVIDER_IDS,
  PROVIDER_NAMES,
  type ProviderId,
  type StoreListing,
} from "@cloud-speech/constants";

/** Every page the nav can mark as current: the data-nav values in Nav.astro
 *  and the `active` prop draw from this union, so a typo or a stale id is a
 *  type error instead of a silently never-highlighted nav entry. */
export type NavPage = ProviderId | "local" | "pricing" | "troubleshooting" | "privacy";

/** Human-readable default keyboard shortcuts, as shown across the site:
 *  display renderings of the shared SHORTCUTS bindings (the same constant
 *  the manifest `commands` section builds its suggested_key from). */
export const shortcuts = {
  readAloud: shortcutDisplay(SHORTCUTS.readAloud),
  download: shortcutDisplay(SHORTCUTS.download),
} as const;

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

// Record keyed by ProviderId so adding a provider to PROVIDER_IDS is a build
// error here until the site metadata exists.
const providerMeta: Record<ProviderId, Omit<Provider, "id" | "name">> = {
  polly: {
    dot: "bg-polly",
    ring: "bg-polly/10",
    blurb:
      "Standard, Neural, Generative, and Long-form voices. Free tier: 5M standard + 1M neural characters/month for the first 12 months.",
  },
  azure: {
    dot: "bg-azure",
    ring: "bg-azure/10",
    blurb:
      "High-quality neural voices in many languages. Free tier: 0.5M neural characters/month, forever.",
  },
  google: {
    dot: "bg-google",
    ring: "bg-google/10",
    blurb:
      "Standard, WaveNet, Neural2, and Chirp HD voices. Free tier: 1M WaveNet + 4M standard characters/month.",
  },
  openai: {
    dot: "bg-openai",
    ring: "bg-openai/10",
    blurb:
      "Expressive tts-1, tts-1-hd, and gpt-4o-mini-tts voices. Simplest setup: one API key, no region. Pay as you go.",
  },
  custom: {
    dot: "bg-custom",
    ring: "bg-custom/10",
    blurb:
      "Any other server that speaks OpenAI's speech API: a hosted service like Groq or DeepInfra, or a LiteLLM proxy in front of other providers.",
  },
};

export const providers: Provider[] = PROVIDER_IDS.map((id) => ({
  id,
  name: PROVIDER_NAMES[id],
  ...providerMeta[id],
}));
