import { browser } from "#imports";

/** A selection inside a child frame (a mail editor, an embedded document) leaves the top document's
 *  selection empty; a frame that refused the injection (a cross-origin sandbox) carries no result. */
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
