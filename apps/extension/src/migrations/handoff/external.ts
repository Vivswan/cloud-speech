import { readStoredSettingsBlob } from "@/lib/storage";
import { updateHandoffBanner } from "./state";

// Fork-listing side of the handoff: answers the unified install over
// runtime.onMessageExternal. The `{ type }` wire format is a published
// contract between store builds and must not change.

interface HandoffMessage {
  type?: string;
}

type ExternalSender = { id?: string };
type SendResponse = (response: unknown) => void;

/** Parameterized for tests. Returns true when a response will arrive
 *  asynchronously (runtime.onMessageExternal contract). */
export function createExternalMessageHandler(unifiedId: string) {
  return (
    message: HandoffMessage,
    sender: ExternalSender,
    sendResponse: SendResponse,
  ): true | undefined => {
    // The settings include provider credentials: answer ONLY the unified
    // listing, never any other extension. sender.id is authenticated by the
    // browser; message contents can't spoof it.
    if (!unifiedId || sender.id !== unifiedId) return;

    if (message?.type === "exportSettings") {
      // The blob travels as stored: the importing install decodes it with its
      // own schema, and a blob its build cannot read must arrive with its
      // real version, not re-stamped as current.
      readStoredSettingsBlob().then(
        (settings) => sendResponse({ ok: true, settings }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }

    if (message?.type === "settingsImported") {
      // dismissedAt resets so a banner snoozed BEFORE the import still shows
      // its one "settings transferred" confirmation. Respond only after the
      // write lands; the ack must not outrun persistence on an event page.
      updateHandoffBanner({ imported: true, dismissedAt: null }).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
  };
}
