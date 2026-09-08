import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import content from "@/entrypoints/content";
import { ERROR_DISMISS_MS } from "@/lib/countdown";
import type { ErrorPayload } from "@/lib/protocol";

// The toast the page sees, driven the way the background drives it: an
// envelope on runtime.onMessage.

const NOTICE: ErrorPayload = {
  title: "Could not read aloud",
  message: "Your Google Cloud TTS key was rejected. Check it in Settings.",
  action: { label: "Fix it on the Google Cloud TTS website", url: "https://console.example/fix" },
  detail: "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403",
};

function shadow(): ShadowRoot {
  const host = document.documentElement.lastElementChild;
  const root = host?.shadowRoot;
  if (!root) throw new Error("the toast host is missing");
  return root;
}

function toast(): HTMLElement | null {
  return shadow().querySelector(".csfc-toast");
}

async function show(payload: ErrorPayload): Promise<void> {
  const reply: unknown = await fakeBrowser.runtime.sendMessage({
    to: "content",
    id: "setError",
    payload,
  });
  expect(reply).toEqual({ ok: true });
}

describe("content script toast", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    fakeBrowser.i18n.getMessage = vi.fn(() => "Dismiss");
    vi.useFakeTimers();
    for (const node of document.documentElement.querySelectorAll("div")) node.remove();
    if (typeof content.main === "function") void content.main({} as never);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows title, message, and the action link, but not the technical detail", async () => {
    await show(NOTICE);
    const shown = toast();
    expect(shown).not.toBeNull();
    expect(shown?.textContent).toContain(NOTICE.title);
    expect(shown?.textContent).toContain(NOTICE.message);
    expect(shown?.textContent).not.toContain(NOTICE.detail);
    const link = shown?.querySelector("a");
    expect(link?.textContent).toBe(NOTICE.action?.label);
    expect(link?.getAttribute("href")).toBe(NOTICE.action?.url);
    expect(link?.getAttribute("target")).toBe("_blank");
  });

  it("goes away on its own, later if the pointer rested on it meanwhile", async () => {
    await show(NOTICE);
    const shown = toast();
    if (!shown) throw new Error("no toast");
    vi.advanceTimersByTime(ERROR_DISMISS_MS / 2);
    shown.dispatchEvent(new Event("pointerenter"));
    vi.advanceTimersByTime(ERROR_DISMISS_MS * 3);
    expect(toast()).toBe(shown);

    shown.dispatchEvent(new Event("pointerleave"));
    vi.advanceTimersByTime(ERROR_DISMISS_MS / 2 - 1);
    expect(toast()).toBe(shown);
    vi.advanceTimersByTime(1);
    expect(toast()).toBeNull();
  });

  it("closes at once from its button", async () => {
    await show(NOTICE);
    const close = shadow().querySelector("button");
    if (!close) throw new Error("no close button");
    expect(close.getAttribute("aria-label")).toBe("Dismiss");
    close.click();
    expect(toast()).toBeNull();
  });

  it("replaces an earlier toast and starts the clock over", async () => {
    await show({ title: "first", message: "m" });
    vi.advanceTimersByTime(ERROR_DISMISS_MS - 1);
    await show({ title: "second", message: "m" });
    expect(shadow().querySelectorAll(".csfc-toast")).toHaveLength(1);
    expect(toast()?.textContent).toContain("second");
    vi.advanceTimersByTime(ERROR_DISMISS_MS - 1);
    expect(toast()?.textContent).toContain("second");
    vi.advanceTimersByTime(1);
    expect(toast()).toBeNull();
  });

  it("renders the payload as text, never as markup", async () => {
    await show({ title: "<img src=x onerror=alert(1)>", message: "<b>bold</b>" });
    const shown = toast();
    expect(shown?.querySelector("img")).toBeNull();
    expect(shown?.querySelector("b")).toBeNull();
    expect(shown?.textContent).toContain("<img src=x onerror=alert(1)>");
  });
});
