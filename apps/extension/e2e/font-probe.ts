// Page-side probes for the bundled typefaces, run in the popup or in a web
// page by both e2e harnesses (Playwright evaluates the function, Selenium its
// source), so they touch only what the page has.

/** The error payload both harnesses push to a tab's content script. */
export const TOAST_ERROR = {
  title: "Synthesis failed",
  message: "The provider rejected the request: check the key.",
};

/** The name the content script registers the sans under (entrypoints/content.ts). */
export const TOAST_FONT = "Cloud Speech Sans";

export interface ToastFonts {
  /** The toast element's computed font-family. */
  readonly family: string;
  /** `<family> <weight> <status>` for every face in the page's document.fonts. */
  readonly faces: readonly string[];
}

/** The toast's font-family and every face of `alias` in document.fonts, each
 *  forced to load so its status is settled. */
export async function readToastFonts(alias: string): Promise<ToastFonts> {
  const host = document.querySelector("div[style*='2147483647']");
  const toast = host?.shadowRoot?.querySelector(".csfc-toast");
  if (!(toast instanceof HTMLElement)) throw new Error("no toast on the page");
  const faces = [...document.fonts].filter((face) => face.family.replace(/"/g, "") === alias);
  await Promise.all(faces.map((face) => face.load().catch(() => undefined)));
  return {
    family: getComputedStyle(toast).fontFamily,
    faces: faces.map((face) => `${face.family.replace(/"/g, "")} ${face.weight} ${face.status}`),
  };
}
