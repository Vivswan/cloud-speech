import { browser } from "#imports";

/** The trimmed text selected in the active tab, "" when there is none or the page allows no injection.
 *  A selection inside a child frame (a mail editor, an embedded document) leaves the top document's
 *  selection empty, so every frame is asked and the first one holding text answers; a frame that
 *  refused the injection (a cross-origin sandbox) comes back with no result and is passed over. */
export async function readActiveTabSelection(): Promise<string> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return "";
    const frames = await browser.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: () => window.getSelection()?.toString() ?? "",
    });
    for (const frame of frames) {
      const text = typeof frame?.result === "string" ? frame.result.trim() : "";
      if (text) return text;
    }
    return "";
  } catch {
    // Privileged page (chrome://, Web Store): no injection allowed there.
    return "";
  }
}
