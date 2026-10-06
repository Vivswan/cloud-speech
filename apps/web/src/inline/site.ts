import { PREFERRED_LOCALE_STORAGE_KEY } from "../i18n/locales";
import {
  normalizeTheme,
  resolveDark,
  THEME_COLORS,
  THEME_CYCLE,
  THEME_STORAGE_KEY,
  type Theme,
} from "./theme";

const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

function storedTheme(): Theme {
  try {
    return normalizeTheme(localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

// data-theme, set pre-paint by Base.astro's inline script, is the runtime truth: it still carries the
// live choice when storage was denied.
function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "dark" || attr === "system" ? attr : storedTheme();
}

function applyTheme(theme: Theme = currentTheme()): void {
  const dark = resolveDark(theme, darkQuery.matches);
  document.documentElement.classList.toggle("dark", dark);
  // The toggle button's icon is CSS-driven off this attribute (styles.css).
  document.documentElement.setAttribute("data-theme", theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? THEME_COLORS.dark : THEME_COLORS.light);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")) {
    // Localized labels are rendered onto the button by Nav.astro.
    const label = button.dataset[`label${theme[0]?.toUpperCase()}${theme.slice(1)}`] ?? theme;
    button.setAttribute("aria-label", label);
    button.title = label;
  }
}

applyTheme();
darkQuery.addEventListener("change", () => {
  if (currentTheme() === "system") applyTheme();
});

for (const button of document.querySelectorAll<HTMLButtonElement>("[data-theme-toggle]")) {
  button.addEventListener("click", () => {
    const next =
      THEME_CYCLE[(THEME_CYCLE.indexOf(currentTheme()) + 1) % THEME_CYCLE.length] ?? "system";
    try {
      if (next === "system") localStorage.removeItem(THEME_STORAGE_KEY);
      else localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
      // Storage denied; the choice still applies until the next navigation.
    }
    applyTheme(next);
  });
}

for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href^="https://"]')) {
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
}

// Pin the choice before the same-tab navigation, or Base.astro's first-visit auto-detect would override
// an explicit pick.
for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[data-locale]")) {
  anchor.addEventListener("click", () => {
    try {
      localStorage.setItem(PREFERRED_LOCALE_STORAGE_KEY, anchor.dataset.locale ?? "en");
    } catch {
      // Storage denied; navigation still works, the pref just isn't pinned.
    }
  });
}

for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.nav-menu")) {
  document.addEventListener("click", (event) => {
    if (menu.open && event.target instanceof Node && !menu.contains(event.target)) {
      menu.open = false;
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      // Return focus to the trigger; otherwise it is lost inside a closed subtree and the next Tab starts from nowhere.
      menu.querySelector<HTMLElement>("summary")?.focus();
    }
  });
}
