import { beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { broadcast, sendToBackground } from "@/lib/messages";

describe("messages", () => {
  beforeEach(() => {
    fakeBrowser.reset();
  });

  it("sendToBackground delivers id + payload and returns the response", async () => {
    fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
      if ((message as { id: string }).id === "readAloud") return Promise.resolve(true);
    });

    const result = await sendToBackground("readAloud", { text: "hi" });
    expect(result).toBe(true);
  });

  it("broadcast never throws when nobody is listening", () => {
    expect(() => broadcast("playerState", { status: "idle" })).not.toThrow();
  });
});
