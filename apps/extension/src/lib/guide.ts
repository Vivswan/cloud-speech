// Base URL of the setup-guide website.
// Dev builds point at the local Vite server (`bun run dev` starts both apps;
// apps/web pins port 5173 with strictPort) so guide edits are live-reloaded.
// Production builds point at the published GitHub Pages site.
const GUIDE_BASE = import.meta.env.DEV
  ? "http://localhost:5173/cloud-speech-for-chrome/"
  : "https://vivswan.github.io/cloud-speech-for-chrome/";

/**
 * URL of a guide SUBPAGE, e.g. guideUrl("setup/polly") →
 * …/cloud-speech-for-chrome/setup/polly/. Each provider has its own page.
 */
export function guideUrl(path: string): string {
  return `${GUIDE_BASE}${path}/`;
}

/** Homepage of the extension website (guides, pricing, troubleshooting). */
export function homepageUrl(): string {
  return GUIDE_BASE;
}
