import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { broadcast, sendToBackground } from "@/lib/messages";

describe("messages", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("sendToBackground delivers id + payload and returns the response", async () => {
    const received: unknown[] = [];
    fakeBrowser.runtime.onMessage.addListener(
      (message: unknown, _sender, sendResponse: (response?: unknown) => void) => {
        received.push(message);
        if ((message as { id: string }).id !== "readAloud") return;
        sendResponse(true);
        return true;
      },
    );

    const result = await sendToBackground("readAloud", { text: "hi" });
    expect(result).toBe(true);
    expect(received).toEqual([{ id: "readAloud", payload: { text: "hi" } }]);
  });

  it("broadcast never throws when nobody is listening", () => {
    expect(() => broadcast("playerState", { status: "idle" })).not.toThrow();
  });
});
