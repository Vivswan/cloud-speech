import { addFaces } from "@/lib/font-loader";
import { SANS } from "@/lib/fonts";
import type { ErrorPayload } from "@/lib/protocol";
import { createContentDispatcher } from "@/lib/protocol-content";

// Content script: shows a lightweight shadow-DOM error toast when the
// background surfaces a synthesis/credential problem on this tab.
// Deliberately vanilla (no React), since it is injected into every page.

// The toast registers the bundled sans under this name so it never collides
// with a page's own declarations of the same family.
const TOAST_FONT = "Cloud Speech Sans";

export default defineContentScript({
  matches: ["<all_urls>"],
  main() {
    let host: HTMLElement | null = null;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

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

      root.innerHTML = `
        <div class="csfc-toast" style="
          position: fixed; top: 16px; right: 16px; max-width: 360px;
          border-left: 4px solid #dc2626; border-radius: 8px;
          box-shadow: 0 8px 24px rgba(0,0,0,.14);
          font-size: 12px; line-height: 1.45; padding: 12px 14px;
          animation: csfc-in .18s ease-out;
        ">
          <div style="font-weight: 600; margin-bottom: 2px;">${escapeHtml(payload.title)}</div>
          <div class="csfc-message">${escapeHtml(payload.message)}</div>
        </div>
        <style>
          @keyframes csfc-in { from { opacity: 0; transform: translateY(-6px); } }
          /* The toast overlays the PAGE, so it follows the OS scheme rather
             than the extension's popup theme setting. */
          .csfc-toast { background: #fff; color: #262626; border: 1px solid #e5e5e5; }
          .csfc-toast { font-family: "${TOAST_FONT}", system-ui, sans-serif; }
          .csfc-message { color: #525252; }
          @media (prefers-color-scheme: dark) {
            .csfc-toast { background: #292524; color: #f5f5f4; border-color: #44403c; }
            .csfc-message { color: #a8a29e; }
          }
        </style>
      `;

      clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (root) root.innerHTML = "";
      }, 8000);
    }

    browser.runtime.onMessage.addListener(
      createContentDispatcher({
        setError: async (payload) => showError(payload),
      }),
    );
  },
});

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
