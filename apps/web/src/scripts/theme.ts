import { PAGE_BG_DARK, PAGE_BG_LIGHT } from "@cloud-speech/constants";

// The site's theme contract, written down once: the localStorage key, the
// allowed values (absence means "system"), the dark-resolution rule, and the
// theme-color hexes. src/scripts/site.ts (the nav theme button) imports
// these; Base.astro inlines initTheme into its pre-paint script by
// serializing the functions below with Function.prototype.toString.

export const THEME_STORAGE_KEY = "theme";

/** The nav button cycles in this order. "system" is stored as absence so a
 *  fresh visitor and an explicit "system" choice behave identically. */
export const THEME_CYCLE = ["system", "light", "dark"] as const;
export type Theme = (typeof THEME_CYCLE)[number];

/** What the theme-color meta carries in each resolved mode: the page
 *  background pair shared with the extension popup via constants. */
export const THEME_COLORS: { readonly light: string; readonly dark: string } = {
  light: PAGE_BG_LIGHT,
  dark: PAGE_BG_DARK,
};

// The two functions below are serialized into Base.astro's inline pre-paint
// script, so they must stay closure-free: parameters and globals only, no
// references to imports or other module members.

/** A stored value normalized to a theme: anything but an explicit
 *  "light"/"dark" (including null and legacy junk) means follow the OS. */
export function normalizeTheme(value: string | null): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

/** Whether a theme renders dark under the given OS preference. */
export function resolveDark(theme: Theme, systemPrefersDark: boolean): boolean {
  return theme === "dark" || (theme === "system" && systemPrefersDark);
}

/** Pre-paint theme init (no flash of the wrong theme): reads storage, sets
 *  `.dark` + `data-theme` on <html> and the theme-color meta. Runs only as
 *  Base.astro's inline script; `normalize`/`resolve` arrive as parameters
 *  because the inlined copy cannot reach this module's exports. */
export function initTheme(
  storageKey: string,
  colors: { light: string; dark: string },
  normalize: typeof normalizeTheme,
  resolve: typeof resolveDark,
): void {
  let stored: string | null = null;
  try {
    stored = localStorage.getItem(storageKey);
  } catch {
    // Read denied; follow the OS.
  }
  const theme = normalize(stored);
  const dark = resolve(theme, matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("dark", dark);
  // The nav theme button's icon is CSS-driven off this attribute, so it is
  // correct before site.ts loads.
  document.documentElement.setAttribute("data-theme", theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? colors.dark : colors.light);
}

/** The inline pre-paint script for Base.astro, assembled from the same
 *  functions site.ts uses so the contract exists exactly once. */
export function themeInitScript(): string {
  const args = [
    JSON.stringify(THEME_STORAGE_KEY),
    JSON.stringify(THEME_COLORS),
    normalizeTheme.toString(),
    resolveDark.toString(),
  ];
  const script = `(${initTheme.toString()})(${args.join(", ")});`;
  // The result is injected via set:html, which HTML-escapes nothing: refuse
  // at build time any content that could terminate the <script> element.
  // Lowercased first: end tags are case-insensitive in HTML.
  const comparable = script.toLowerCase();
  if (comparable.includes("</script") || comparable.includes("<!--")) {
    throw new Error("themeInitScript: serialized script contains an HTML terminator sequence");
  }
  return script;
}
