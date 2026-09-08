import { type Countdown, ERROR_DISMISS_MS, startCountdown } from "@/lib/countdown";
import { addFaces } from "@/lib/font-loader";
import { SANS } from "@/lib/fonts";
import type { ErrorPayload } from "@/lib/protocol";
import { createContentDispatcher } from "@/lib/protocol-content";

// Content script: shows a lightweight shadow-DOM error toast when the
// background surfaces a synthesis/credential problem on this tab.
// Deliberately vanilla (no React), since it is injected into every page. The
// strings arrive localized in the payload: no i18n runtime here.

// The toast registers the bundled sans under this name so it never collides
// with a page's own declarations of the same family.
const TOAST_FONT = "Cloud Speech Sans";

const STYLE = `
  .csfc-toast {
    position: fixed; top: 16px; right: 16px; max-width: 360px;
    display: flex; align-items: flex-start; gap: 8px;
    box-shadow: 0 8px 24px rgba(0,0,0,.14); border-radius: 8px;
    font: 400 12px/1.45 "${TOAST_FONT}", system-ui, sans-serif; padding: 12px 14px;
    animation: csfc-in .18s ease-out;
    background: #fff; color: #262626;
    border: 1px solid #e5e5e5; border-left: 4px solid #dc2626;
  }
  @keyframes csfc-in { from { opacity: 0; transform: translateY(-6px); } }
  @media (prefers-reduced-motion: reduce) { .csfc-toast { animation: none; } }
  .csfc-body { min-width: 0; flex: 1; }
  .csfc-title { font-weight: 600; margin-bottom: 2px; }
  .csfc-message { color: #525252; }
  .csfc-action { display: inline-block; margin-top: 6px; color: #b91c1c; font-weight: 600; }
  .csfc-details { margin-top: 6px; font-size: 11px; }
  .csfc-details summary { cursor: pointer; color: #737373; }
  .csfc-detail {
    margin: 4px 0 0; max-height: 96px; overflow: auto; white-space: pre-wrap; word-break: break-all;
    font: 10px/1.4 ui-monospace, monospace; color: #525252;
  }
  .csfc-close { all: unset; cursor: pointer; padding: 2px; border-radius: 4px; line-height: 0; color: #737373; }
  .csfc-close:hover, .csfc-close:focus-visible { background: #f5f5f4; color: #262626; }
  /* The toast overlays the PAGE, so it follows the OS scheme rather than the
     extension's popup theme setting. */
  @media (prefers-color-scheme: dark) {
    .csfc-toast { background: #292524; color: #f5f5f4; border-color: #44403c; border-left-color: #dc2626; }
    .csfc-message { color: #a8a29e; }
    .csfc-action { color: #f87171; }
    .csfc-details summary, .csfc-detail { color: #a8a29e; }
    .csfc-close:hover, .csfc-close:focus-visible { background: #44403c; color: #f5f5f4; }
  }
`;

const CLOSE_ICON =
  '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M18 6 6 18M6 6l12 12"/></svg>';

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    let host: HTMLElement | null = null;
    let countdown: Countdown | undefined;

    function showError(payload: ErrorPayload): void {
      if (!host) {
        host = document.createElement("div");
        host.style.cssText = "all: initial; position: fixed; z-index: 2147483647;";
        document.documentElement.appendChild(host);
        host.attachShadow({ mode: "open" });
        // @font-face inside a shadow tree is ignored, so the faces join the
        // page's document.fonts, which the shadow tree sees; a page that never
        // shows a toast never fetches them.
        addFaces(document.fonts, SANS, { as: TOAST_FONT, weights: [400, 600] });
      }
      const root = host.shadowRoot;
      if (!root) return;

      const dismiss = (): void => {
        countdown?.cancel();
        countdown = undefined;
        root.replaceChildren();
      };
      dismiss();

      const style = document.createElement("style");
      style.textContent = STYLE;
      const toast = element("div", "csfc-toast");
      toast.setAttribute("role", "alert");
      const body = element("div", "csfc-body");
      body.append(
        element("div", "csfc-title", payload.title),
        element("div", "csfc-message", payload.message),
      );
      if (payload.action) {
        const link = element("a", "csfc-action", payload.action.label);
        link.href = payload.action.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        body.append(link);
      }
      // The technical text behind a collapsed Details, as in the popup banner.
      const details = element("details", "csfc-details");
      details.append(
        element("summary", "", pageLabel("errors_details", "Details")),
        element("pre", "csfc-detail", payload.detail),
      );
      body.append(details);
      const close = element("button", "csfc-close");
      close.type = "button";
      close.setAttribute("aria-label", pageLabel("common_dismiss", "Dismiss"));
      close.innerHTML = CLOSE_ICON;
      close.addEventListener("click", dismiss);
      toast.append(body, close);
      root.append(style, toast);

      // The countdown waits while the pointer or the keyboard focus is on the
      // toast, and continues from where it stopped once both have left.
      const timer = startCountdown(ERROR_DISMISS_MS, dismiss);
      countdown = timer;
      toast.addEventListener("pointerenter", () => timer.hold("pointer"));
      toast.addEventListener("pointerleave", () => timer.release("pointer"));
      toast.addEventListener("focusin", () => timer.hold("focus"));
      toast.addEventListener("focusout", (event) => {
        if (!(event.relatedTarget instanceof Node && toast.contains(event.relatedTarget))) {
          timer.release("focus");
        }
      });
    }

    browser.runtime.onMessage.addListener(
      createContentDispatcher({
        setError: async (payload) => showError(payload),
      }),
    );
  },
});

/** The two strings not in the payload (the close button's label, the
 *  Details summary), in the browser's language: the page has no i18n
 *  runtime. WXT narrows getMessage's key to its built-ins; this is the same
 *  sanctioned cast lib/i18n-runtime.ts makes for dynamic keys. */
function pageLabel(key: string, fallback: string): string {
  const messageKey = key as Parameters<typeof browser.i18n.getMessage>[0];
  return browser.i18n.getMessage(messageKey) || fallback;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
