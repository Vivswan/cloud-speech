// Theme: `.dark` on <html>, cycled by the nav theme button. Storage layout
// matches the inline pre-paint script in Base.astro: "theme" holds
// "light" | "dark"; absent (or "system") means follow the OS.
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const THEME_CYCLE = ["system", "light", "dark"] as const;
type Theme = (typeof THEME_CYCLE)[number];

function storedTheme(): Theme {
  try {
    const stored = localStorage.getItem("theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

// The html[data-theme] attribute (set by the pre-paint script in Base.astro)
// is the runtime source of truth: unlike storage it always exists and still
// carries the live choice when persisting was denied.
function currentTheme(): Theme {
  const attr = document.documentElement.getAttribute("data-theme");
  return attr === "light" || attr === "dark" || attr === "system" ? attr : storedTheme();
}

function applyTheme(theme: Theme = currentTheme()): void {
  const dark = theme === "dark" || (theme === "system" && darkQuery.matches);
  document.documentElement.classList.toggle("dark", dark);
  // The toggle button's icon is CSS-driven off this attribute (styles.css).
  document.documentElement.setAttribute("data-theme", theme);
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", dark ? "#1c1917" : "#fafaf9");
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
      // "system" is stored as absence so a fresh visitor and an explicit
      // "system" choice behave identically in the pre-paint script.
      if (next === "system") localStorage.removeItem("theme");
      else localStorage.setItem("theme", next);
    } catch {
      // Storage denied; the choice still applies until the next navigation.
    }
    applyTheme(next);
  });
}

// External links open in a new tab.
for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href^="https://"]')) {
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
}

// Language switcher: pin the choice BEFORE the same-tab navigation, so the
// first-visit auto-detect in Base.astro never overrides an explicit pick.
for (const anchor of document.querySelectorAll<HTMLAnchorElement>("a[data-locale]")) {
  anchor.addEventListener("click", () => {
    try {
      localStorage.setItem("preferred-locale", anchor.dataset.locale ?? "en");
    } catch {
      // Storage denied; navigation still works, the pref just isn't pinned.
    }
  });
}

// Mark the current page for assistive tech (the visual state is CSS-driven).
const nav = document.querySelector<HTMLElement>("nav[data-active]");
const activePage = nav?.dataset.active;
if (nav && activePage) {
  nav.querySelector(`a[data-nav="${activePage}"]`)?.setAttribute("aria-current", "page");
}

// Close the nav "Setup" dropdown on outside click or Escape.
for (const menu of document.querySelectorAll<HTMLDetailsElement>("details.nav-menu")) {
  document.addEventListener("click", (event) => {
    if (menu.open && event.target instanceof Node && !menu.contains(event.target)) {
      menu.open = false;
    }
  });
  menu.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && menu.open) {
      menu.open = false;
      // Return focus to the trigger; otherwise it's lost inside a closed
      // subtree and the next Tab starts from nowhere.
      menu.querySelector<HTMLElement>("summary")?.focus();
    }
  });
}
