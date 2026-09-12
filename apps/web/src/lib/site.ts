import {
  GITHUB_REPO_URL,
  PROVIDER_IDS,
  PROVIDER_NAMES,
  type ProviderId,
  SHORTCUTS,
  shortcutDisplay,
} from "@cloud-speech/constants";
import { freeTier } from "./pricing";

export {
  chromeListing,
  firefoxListing,
  GITHUB_ISSUES_URL,
  GITHUB_REPO_URL,
  type ProviderId,
} from "@cloud-speech/constants";

/** Nav.astro's data-nav values and the `active` prop draw from this union, so a stale id is a type error,
 *  not a never-highlighted entry. */
export type NavPage =
  | ProviderId
  | "local"
  | "walkthrough"
  | "pricing"
  | "troubleshooting"
  | "privacy";

/** The `store-screenshots` branch .github/workflows/publish-screenshots.yml force-pushes; the files are never on
 *  main, so the page builds before the branch exists. `astro dev` serves a local render when one exists (lib/screenshot-source.ts). */
export const STORE_SCREENSHOTS_URL = new URL(
  `${new URL(GITHUB_REPO_URL).pathname}/store-screenshots/`,
  "https://raw.githubusercontent.com",
).href;

/** Display forms of the same SHORTCUTS the manifest builds its suggested_key from. */
export const shortcuts = {
  readAloud: shortcutDisplay(SHORTCUTS.readAloud),
  download: shortcutDisplay(SHORTCUTS.download),
} as const;

export interface Provider {
  id: ProviderId;
  name: string;
  dot: string;
  ring: string;
  blurb: string;
}

// Keyed by ProviderId so a new PROVIDER_IDS entry is a build error until its metadata exists.
// apps/extension/tests/lib/roster-sync.test.ts pins the model families each blurb names to the extension's rosters.
const providerMeta: Record<ProviderId, Omit<Provider, "id" | "name">> = {
  polly: {
    dot: "bg-polly",
    ring: "bg-polly/10",
    blurb: `Standard, Neural, Generative, and Long-form voices. Free tier: ${freeTier.polly.standardM}M standard + ${freeTier.polly.neuralM}M neural characters/month for the first ${freeTier.polly.firstMonths} months.`,
  },
  azure: {
    dot: "bg-azure",
    ring: "bg-azure/10",
    blurb: `High-quality neural voices in many languages. Free tier: ${freeTier.azure.neuralM}M neural characters/month, forever.`,
  },
  google: {
    dot: "bg-google",
    ring: "bg-google/10",
    blurb: `Standard, WaveNet, Neural2, Chirp HD, Chirp 3 HD, and Gemini voices. Free tier: ${freeTier.google.wavenetM}M WaveNet + ${freeTier.google.standardM}M standard characters/month.`,
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
