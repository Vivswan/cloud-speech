import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { readActiveTabSelection, readFrameSelection } from "@/lib/page-selection";

// The browser answers one entry per frame, the main frame first and the child frames in no particular
// order, and a frame that refused the injection carries no result: the shape is the platform's, not ours,
// so the walk over it is pinned here.
const frame = (text: string, focused = false) => ({ result: { text, focused } });
const executeScript =
  vi.fn<(injection: { target: { allFrames?: boolean } }) => Promise<unknown[]>>();

beforeEach(() => {
  fakeBrowser.reset();
  executeScript.mockReset();
  Object.assign(fakeBrowser, { scripting: { executeScript } });
  Object.assign(fakeBrowser.tabs, { query: vi.fn(async () => [{ id: 4 }]) });
});

describe("readActiveTabSelection", () => {
  it.each([
    {
      name: "the top document is empty and a child frame holds the selection",
      frames: [frame(""), frame("  Selected in the frame\n")],
      expected: "Selected in the frame",
    },
    {
      name: "a frame that refused the injection sits between the empty top document and the selection",
      frames: [frame(""), { frameId: 3 }, frame("After the refused frame")],
      expected: "After the refused frame",
    },
    {
      name: "child-frame order is unspecified: a focused later frame wins over an unfocused earlier frame with text",
      frames: [frame(""), frame("Left behind in another frame"), frame("Just selected", true)],
      expected: "Just selected",
    },
  ])("$name", async ({ frames, expected }) => {
    executeScript.mockResolvedValue(frames);

    expect(await readActiveTabSelection()).toBe(expected);
    expect(executeScript).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ target: { tabId: 4, allFrames: true } }),
    );
  });

  it("a page that allows no injection reads as no selection instead of failing the caller", async () => {
    executeScript.mockRejectedValue(new Error("Cannot access a chrome:// URL"));

    expect(await readActiveTabSelection()).toBe("");
  });
});

// document.hasFocus() answers true in every ancestor document of the focused frame, not only in the
// frame the user is typing in: with a stale selection on the top document and the user selecting inside
// an iframe, both frames would report focus and Chrome lists the top document first.
describe("readFrameSelection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete (document as { activeElement?: Element }).activeElement;
  });

  // The platform retargets activeElement to the shadow host; the frame element is on the shadow root.
  const hostOf = (tag: string) => {
    const host = document.createElement("div");
    const root = host.attachShadow({ mode: "open" });
    Object.defineProperty(root, "activeElement", { value: document.createElement(tag) });
    return host;
  };

  it.each([
    {
      name: "an ancestor whose active element is an <iframe> is not the focused leaf",
      active: () => document.createElement("iframe"),
      focused: false,
    },
    {
      name: "an ancestor whose active element is a <frame> is not the focused leaf",
      active: () => document.createElement("frame"),
      focused: false,
    },
    {
      name: "an ancestor whose <iframe> sits inside a shadow root reports the host, and is not the focused leaf",
      active: () => hostOf("iframe"),
      focused: false,
    },
    {
      name: "the document whose active element is ordinary content is the focused leaf",
      active: () => document.createElement("p"),
      focused: true,
    },
  ])("$name", ({ active, focused }) => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    Object.defineProperty(document, "activeElement", { configurable: true, value: active() });

    expect(readFrameSelection()).toEqual({ text: "", focused });
  });
});
