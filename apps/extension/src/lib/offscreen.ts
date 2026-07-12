import { browser } from "#imports";

let creating: Promise<void> | null = null;

/** Ensure the offscreen audio document exists (singleton-guarded). */
export async function ensureOffscreenDocument(): Promise<void> {
  // A creation may be in flight: getContexts can already report the document
  // while its scripts haven't run yet — a message sent then is silently lost.
  // Always wait for the creating call instead of trusting the early return.
  if (creating) {
    await creating;
    return;
  }

  const url = browser.runtime.getURL("/offscreen.html");

  const contexts = await browser.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT" as never],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;

  if (!creating) {
    creating = browser.offscreen
      .createDocument({
        url,
        reasons: ["AUDIO_PLAYBACK" as never],
        justification: "Play synthesized speech (MV3 service workers cannot play audio)",
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}
