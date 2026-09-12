import { getSettings, type Settings, watchSettings } from "@/lib/storage";

/**
 * Toggles `.dark` on <html>; styles.css flips the semantic tokens under that
 * class. MV3's extension_pages CSP forbids inline <script>, so the earliest
 * run is module top of main.tsx, and browser.storage reads are async: to
 * avoid a wrong-theme flash on reopen, the preference is mirrored into
 * localStorage, a per-window render cache and never the source of truth.
 */

export type Theme = Settings["theme"];

const CACHE_KEY = "csfc:theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

export function resolveTheme(theme: Theme, prefersDark: boolean): "light" | "dark" {
  if (theme === "system") return prefersDark ? "dark" : "light";
  return theme;
}

function readCachedTheme(): Theme {
  try {
    const cached = window.localStorage.getItem(CACHE_KEY);
    if (cached === "light" || cached === "dark" || cached === "system") return cached;
  } catch {
    // localStorage unavailable; fall through to the default.
  }
  return "system";
}

function prefersDark(): boolean {
  return window.matchMedia(DARK_QUERY).matches;
}

function apply(theme: Theme): void {
  document.documentElement.classList.toggle("dark", resolveTheme(theme, prefersDark()) === "dark");
}

/** Synchronous first paint from the localStorage cache; call before render. */
export function applyInitialTheme(): void {
  apply(readCachedTheme());
}

/** Returns a cleanup so re-initialization stays leak-free; the popup never
 *  calls it, since its window teardown drops everything. */
export function initTheme(): () => void {
  applyInitialTheme();

  let current = readCachedTheme();
  let sawWatchEvent = false;
  const applyAndCache = (theme: Theme) => {
    current = theme;
    apply(theme);
    try {
      window.localStorage.setItem(CACHE_KEY, theme);
    } catch {
      // Cache miss just means a potential one-frame flash next open.
    }
  };

  // A watch event carries newer state than the initial read; never let a
  // slow getSettings() overwrite it.
  void getSettings().then((settings) => {
    if (!sawWatchEvent) applyAndCache(settings.theme);
  });
  const unwatch = watchSettings((settings) => {
    sawWatchEvent = true;
    applyAndCache(settings.theme);
  });

  const media = window.matchMedia(DARK_QUERY);
  const onMediaChange = () => {
    if (current === "system") apply(current);
  };
  media.addEventListener("change", onMediaChange);

  return () => {
    sawWatchEvent = true; // neutralize a still-pending initial read
    unwatch();
    media.removeEventListener("change", onMediaChange);
  };
}
