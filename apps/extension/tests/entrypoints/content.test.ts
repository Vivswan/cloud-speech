import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import content from "@/entrypoints/content";
import { ERROR_DISMISS_MS } from "@/lib/countdown";
import type { ErrorToast } from "@/lib/protocol";

// The toast the page sees, driven the way the background drives it: an
// envelope on runtime.onMessage. Every string it shows arrives in the
// payload, the two control labels included; the page has no i18n runtime,
// and the browser's own lookup answers in the browser's language, not the
// extension's chosen one. The labels here are not the browser's, so a toast
// that asked the browser would show up.

const LABELS = { details: "विवरण", dismiss: "खारिज करें" };

const NOTICE: ErrorToast = {
  title: "Could not read aloud",
  message: "Your Google Cloud TTS key was rejected. Check it in Settings.",
  action: { label: "Fix it on the Google Cloud TTS website", url: "https://console.example/fix" },
  detail: "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403",
  labels: LABELS,
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

async function show(payload: ErrorToast): Promise<void> {
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
    // The browser's own labels, which the toast must not fall back to.
    fakeBrowser.i18n.getMessage = vi.fn(
      (key: string) => ({ common_dismiss: "Dismiss", errors_details: "Details" })[key] ?? "",
    );
    vi.useFakeTimers();
    for (const node of document.documentElement.querySelectorAll("div")) node.remove();
    if (typeof content.main === "function") void content.main({} as never);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows title, message, the action link, the technical detail collapsed, and the labels it was given", async () => {
    await show(NOTICE);
    const shown = toast();
    expect(shown).not.toBeNull();
    expect(shown?.textContent).toContain(NOTICE.title);
    expect(shown?.textContent).toContain(NOTICE.message);
    const link = shown?.querySelector("a");
    expect(link?.textContent).toBe(NOTICE.action?.label);
    expect(link?.getAttribute("href")).toBe(NOTICE.action?.url);
    expect(link?.getAttribute("target")).toBe("_blank");
    const details = shown?.querySelector("details");
    expect(details?.open).toBe(false);
    expect(details?.querySelector("summary")?.textContent).toBe(LABELS.details);
    expect(details?.querySelector("pre")?.textContent).toBe(NOTICE.detail);
    expect(shown?.querySelector("button")?.getAttribute("aria-label")).toBe(LABELS.dismiss);
    expect(fakeBrowser.i18n.getMessage).not.toHaveBeenCalled();
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

  it("waits while the keyboard focus is inside it, also as focus moves between its controls", async () => {
    await show(NOTICE);
    const shown = toast();
    const summary = shown?.querySelector("summary");
    const close = shown?.querySelector("button");
    if (!shown || !summary || !close) throw new Error("no toast");
    vi.advanceTimersByTime(ERROR_DISMISS_MS / 2);
    summary.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(ERROR_DISMISS_MS * 3);
    expect(toast()).toBe(shown);

    // Tab from the Details summary to the close button: still inside.
    summary.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: close }));
    close.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    vi.advanceTimersByTime(ERROR_DISMISS_MS * 3);
    expect(toast()).toBe(shown);

    close.dispatchEvent(new FocusEvent("focusout", { bubbles: true, relatedTarget: null }));
    vi.advanceTimersByTime(ERROR_DISMISS_MS / 2 - 1);
    expect(toast()).toBe(shown);
    vi.advanceTimersByTime(1);
    expect(toast()).toBeNull();
  });

  it("closes at once from its button", async () => {
    await show(NOTICE);
    const close = shadow().querySelector("button");
    if (!close) throw new Error("no close button");
    expect(close.getAttribute("aria-label")).toBe(LABELS.dismiss);
    close.click();
    expect(toast()).toBeNull();
  });

  it("replaces an earlier toast and starts the clock over", async () => {
    await show({ title: "first", message: "m", detail: "d", labels: LABELS });
    vi.advanceTimersByTime(ERROR_DISMISS_MS - 1);
    await show({ title: "second", message: "m", detail: "d", labels: LABELS });
    expect(shadow().querySelectorAll(".csfc-toast")).toHaveLength(1);
    expect(toast()?.textContent).toContain("second");
    vi.advanceTimersByTime(ERROR_DISMISS_MS - 1);
    expect(toast()?.textContent).toContain("second");
    vi.advanceTimersByTime(1);
    expect(toast()).toBeNull();
  });

  it("renders the payload as text, never as markup", async () => {
    await show({
      title: "<img src=x onerror=alert(1)>",
      message: "<b>bold</b>",
      detail: "<script>alert(2)</script>",
      labels: { details: "<i>Details</i>", dismiss: "<u>Dismiss</u>" },
    });
    const shown = toast();
    expect(shown?.querySelector("img")).toBeNull();
    expect(shown?.querySelector("b")).toBeNull();
    expect(shown?.querySelector("script")).toBeNull();
    expect(shown?.querySelector("i")).toBeNull();
    expect(shown?.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(shown?.querySelector("summary")?.textContent).toBe("<i>Details</i>");
    expect(shown?.querySelector("button")?.getAttribute("aria-label")).toBe("<u>Dismiss</u>");
    expect(shown?.querySelector("pre")?.textContent).toBe("<script>alert(2)</script>");
  });
});
