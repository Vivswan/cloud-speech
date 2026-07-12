import { browser } from "#imports";
import { i18n } from "@/lib/i18n-background";
import { broadcast, type ErrorPayload } from "./messages";
import { NoVoiceSelectedError, ProviderDisabledError } from "./synthesize";

/**
 * Surface an error to the user: content-script toast on the active tab plus a
 * runtime broadcast the popup listens to. Never throws.
 */
export async function surfaceError(error: unknown): Promise<void> {
  const payload: ErrorPayload =
    error instanceof NoVoiceSelectedError
      ? {
          title: i18n.t("errors.no_voice_title"),
          message: i18n.t("errors.no_voice_message"),
        }
      : error instanceof ProviderDisabledError
        ? {
            title: i18n.t("errors.provider_disabled_title"),
            message: i18n.t("errors.provider_disabled_message"),
          }
        : { title: i18n.t("errors.synthesis_failed_title"), message: String(error) };

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      browser.tabs.sendMessage(tab.id, { id: "setError", payload }).catch(() => {});
    }
  } catch {
    // No active tab (e.g. chrome:// page) — the broadcast below still lands.
  }
  broadcast("backgroundError", payload);
}
