import { enqueueWrite, readStoredSettingsBlob } from "@/lib/storage";
import { markHandoffImported } from "./state";

// Fork side, over runtime.onMessageExternal. The `{ type }` wire format is a published contract
// between store builds and must not change.

interface HandoffMessage {
  type?: string;
}

type ExternalSender = { id?: string };
type SendResponse = (response: unknown) => void;

/** Parameterized for tests. Returns true when a response will arrive asynchronously (the
 *  runtime.onMessageExternal contract). */
export function createExternalMessageHandler(unifiedId: string) {
  return (
    message: HandoffMessage,
    sender: ExternalSender,
    sendResponse: SendResponse,
  ): true | undefined => {
    // The settings include credentials: answer only the unified listing. sender.id is
    // authenticated by the browser; message contents cannot spoof it.
    if (!unifiedId || sender.id !== unifiedId) return;

    if (message?.type === "exportSettings") {
      // The blob travels as stored: one the importing build cannot read must arrive with its real
      // version, not re-stamped as current. Read under the settings lock: the request can arrive
      // while this start's flat-key conversion holds it, and an answer read earlier is empty.
      enqueueWrite(() => readStoredSettingsBlob()).then(
        (settings) => sendResponse({ ok: true, settings }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }

    if (message?.type === "settingsImported") {
      // Respond only after the write lands; the ack must not outrun persistence on an event page.
      markHandoffImported().then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
  };
}
