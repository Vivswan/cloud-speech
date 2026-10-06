import { browser } from "#imports";

// Firefox for Android ships neither the context menu nor the commands API, so
// there the popup is the only entry point. Feature checks, never user-agent
// sniffing: a browser that grows an API gets it without a code change.

export function hasContextMenus(): boolean {
  return typeof browser.contextMenus !== "undefined";
}

export function hasCommands(): boolean {
  return typeof browser.commands !== "undefined";
}
