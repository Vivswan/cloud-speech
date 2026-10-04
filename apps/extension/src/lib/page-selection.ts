import { browser } from "#imports";

type FrameSelection = { text: string; focused: boolean };

function isFrameSelection(result: unknown): result is FrameSelection {
  return (
    typeof result === "object" &&
    result !== null &&
    typeof (result as FrameSelection).text === "string" &&
    typeof (result as FrameSelection).focused === "boolean"
  );
}

/** A selection inside a child frame (a mail editor, an embedded document) leaves the top document's
 *  selection empty; a frame that refused the injection (a cross-origin sandbox) carries no result.
 *  Chrome answers with the main frame first and the child frames in no particular order, so a
 *  selection left behind in one frame could outrank the one the user just made. */
export async function readActiveTabSelection(): Promise<string> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return "";
    const frames = await browser.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: (): FrameSelection => ({
        text: window.getSelection()?.toString() ?? "",
        focused: document.hasFocus(),
      }),
    });
    let unfocused = "";
    for (const frame of frames) {
      const selection = frame?.result;
      if (!isFrameSelection(selection)) continue;
      const text = selection.text.trim();
      if (!text) continue;
      if (selection.focused) return text;
      unfocused ||= text;
    }
    return unfocused;
  } catch {
    // Privileged page (chrome://, Web Store): no injection allowed there.
    return "";
  }
}
