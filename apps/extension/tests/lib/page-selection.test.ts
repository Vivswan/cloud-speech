import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { readActiveTabSelection } from "@/lib/page-selection";

// The browser answers one entry per frame, top document first, and a frame that refused the
// injection carries no result: the shape is the platform's, not ours, so the walk over it is pinned here.
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
      frames: [{ result: "" }, { result: "  Selected in the frame\n" }],
      expected: "Selected in the frame",
    },
    {
      name: "a frame that refused the injection sits between the empty top document and the selection",
      frames: [{ result: "" }, { frameId: 3 }, { result: "After the refused frame" }],
      expected: "After the refused frame",
    },
    {
      name: "several frames hold text: the first in frame order wins",
      frames: [{ result: "" }, { result: "first" }, { result: "second" }],
      expected: "first",
    },
    {
      name: "every frame is empty or whitespace",
      frames: [{ result: " \n" }, { result: "" }],
      expected: "",
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
