import { browser } from "#imports";

// Which optional browser APIs this build is running with. Firefox for Android
// ships neither the context menu nor the commands API, so there the popup
// (the Sandbox and its Use selection banner) is the only entry point. These
// are feature checks, never user-agent sniffing: a browser that grows an API
// gets it without a code change, and the namespace is simply absent where
// the API is not implemented.

/** Whether `browser.contextMenus` exists here. */
export function hasContextMenus(): boolean {
  return typeof browser.contextMenus !== "undefined";
}

/** Whether `browser.commands` (keyboard shortcuts) exists here. */
export function hasCommands(): boolean {
  return typeof browser.commands !== "undefined";
}
