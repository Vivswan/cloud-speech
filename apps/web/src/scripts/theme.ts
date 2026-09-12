import { PAGE_BG_DARK, PAGE_BG_LIGHT } from "@cloud-speech/constants";

// The theme contract exists once, here: src/scripts/site.ts imports it, and Base.astro inlines it
// pre-paint by serializing the functions below with Function.prototype.toString (themeInitScript).

export const THEME_STORAGE_KEY = "theme";

/** "system" is stored as absence, so a fresh visitor and an explicit "system" pick behave identically. */
export const THEME_CYCLE = ["system", "light", "dark"] as const;
export type Theme = (typeof THEME_CYCLE)[number];

/** The theme-color meta values: the same pair the extension popup paints its background with. */
export const THEME_COLORS: { readonly light: string; readonly dark: string } = {
  light: PAGE_BG_LIGHT,
  dark: PAGE_BG_DARK,
};

// Everything from here to themeInitScript is serialized into Base.astro's inline pre-paint script, so it must
// stay closure-free (parameters and globals only); scripts/check-theme-init.mjs runs the emitted copy.

export function normalizeTheme(value: string | null): Theme {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveDark(theme: Theme, systemPrefersDark: boolean): boolean {
  return theme === "dark" || (theme === "system" && systemPrefersDark);
}

/** Runs only as Base.astro's inline script, before first paint. `normalize` and `resolve` arrive as
 *  parameters because the inlined copy cannot reach this module's exports. */
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
  // styles.css picks the nav theme icon off this attribute, so it is right before site.ts loads.
  document.documentElement.setAttribute("data-theme", theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? colors.dark : colors.light);
}

export function themeInitScript(): string {
  const args = [
    JSON.stringify(THEME_STORAGE_KEY),
    JSON.stringify(THEME_COLORS),
    normalizeTheme.toString(),
    resolveDark.toString(),
  ];
  const script = `(${initTheme.toString()})(${args.join(", ")});`;
  // set:html escapes nothing, so anything that could end the <script> element is refused at build time.
  // End tags are case-insensitive, hence the lowercase.
  const comparable = script.toLowerCase();
  if (comparable.includes("</script") || comparable.includes("<!--")) {
    throw new Error("themeInitScript: serialized script contains an HTML terminator sequence");
  }
  return script;
}
