import { DEV_SITE_URL, SITE_URL } from "@cloud-speech/constants";

// Base URL of the setup-guide website (single-sourced in the shared
// @cloud-speech/constants package).
// Dev builds point at the local Vite server (`bun run dev` starts both apps;
// apps/web pins the port with strictPort) so guide edits are live-reloaded.
// Production builds point at the published GitHub Pages site.
const GUIDE_BASE = import.meta.env.DEV ? DEV_SITE_URL : SITE_URL;

/**
 * URL of a guide SUBPAGE, e.g. guideUrl("setup/polly") →
 * …/cloud-speech/setup/polly/. Each provider has its own page.
 */
export function guideUrl(path: string): string {
  return `${GUIDE_BASE}${path}/`;
}

/** Homepage of the extension website (guides, pricing, troubleshooting). */
export function homepageUrl(): string {
  return GUIDE_BASE;
}
