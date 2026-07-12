// External links open in a new tab.
for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href^="https://"]')) {
  anchor.target = "_blank";
  anchor.rel = "noopener noreferrer";
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
      // Return focus to the trigger — otherwise it's lost inside a closed
      // subtree and the next Tab starts from nowhere.
      menu.querySelector<HTMLElement>("summary")?.focus();
    }
  });
}
