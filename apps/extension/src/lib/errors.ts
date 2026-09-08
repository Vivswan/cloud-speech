import { PROVIDER_NAMES, type ProviderId } from "@cloud-speech/constants";
import { browser } from "#imports";
import { i18n, type MessageKey, tDynamic } from "@/lib/i18n-runtime";
import { getProvider, providerList } from "@/providers";
import type { ErrorDescription, FailureKind, TtsProvider } from "@/providers/types";
import { type ErrorPayload, emit } from "./protocol";
import { failureKindForStatus, isNetworkFailure, ProviderHttpError } from "./provider-http";
import { redactSecrets } from "./provider-validation";
import { NoVoiceSelectedError, ProviderDisabledError } from "./synthesize";

// ---------------------------------------------------------------------------
// What the user reads when something fails: the failure's class in plain
// words, with the one thing to do about it, and the raw technical text kept
// apart as `detail`. Classes are provider-neutral; a provider only recognizes
// its own error bodies (TtsProvider.describeError). Nothing here switches on
// a provider id.
// ---------------------------------------------------------------------------

/** What the caller knows about where the error came from. A fetch that never
 *  got an answer carries no provider of its own, so without this it is
 *  reported without a provider name. */
export interface FailureContext {
  providerId?: ProviderId;
}

const STOCK_MESSAGE: Record<FailureKind, MessageKey> = {
  key_rejected: "errors.key_rejected_message",
  api_disabled: "errors.api_disabled_message",
  quota_exhausted: "errors.quota_exhausted_message",
  rate_limited: "errors.rate_limited_message",
  provider_outage: "errors.provider_outage_message",
  request_refused: "errors.request_refused_message",
  unreachable: "errors.unreachable_message",
  unknown: "errors.unknown_message",
};

interface Attribution {
  provider?: TtsProvider;
  description?: ErrorDescription;
}

/** The provider the error belongs to and what it says about it: named by the
 *  error itself, else by the caller, else the one provider that recognizes
 *  the error as its own. */
function attribute(error: unknown, context: FailureContext): Attribution {
  if (error instanceof ProviderHttpError) {
    const provider = getProvider(error.provider);
    return { provider, description: provider.describeError?.(error) };
  }
  if (context.providerId) {
    const provider = getProvider(context.providerId);
    return { provider, description: provider.describeError?.(error) };
  }
  for (const provider of providerList) {
    const description = provider.describeError?.(error);
    if (description) return { provider, description };
  }
  return {};
}

/** The reading that needs no provider knowledge: the HTTP status class, or a
 *  request that never got an answer. */
function genericDescription(error: unknown): ErrorDescription | undefined {
  if (error instanceof ProviderHttpError) return { kind: failureKindForStatus(error.status) };
  if (isNetworkFailure(error)) return { kind: "unreachable" };
  return undefined;
}

/** Sentences the background and the transport throw as plain Errors, already
 *  in the user's words. A plain Error carries no other mark, so they are
 *  recognized by their translation. */
const NOTICE_KEYS: MessageKey[] = ["errors.no_selection", "errors.audio_unavailable"];

function isNotice(error: unknown): error is Error {
  return error instanceof Error && NOTICE_KEYS.some((key) => i18n.t(key) === error.message);
}

function notice(provider: TtsProvider | undefined, description: ErrorDescription): ErrorPayload {
  const providerName = provider ? PROVIDER_NAMES[provider.id] : undefined;
  const substitutions = [providerName ?? "", description.feature ?? ""];
  const messageKey =
    description.messageKey ??
    (description.kind === "unreachable" ? provider?.unreachableMessageKey : undefined);
  let message: string;
  if (messageKey) {
    message = tDynamic(messageKey, substitutions);
  } else if (description.kind === "unreachable" && providerName === undefined) {
    message = i18n.t("errors.unreachable_service_message");
  } else {
    message = i18n.t(STOCK_MESSAGE[description.kind], substitutions);
  }
  const payload: ErrorPayload = { title: i18n.t("errors.read_failed_title"), message };
  if (description.actionUrl && providerName) {
    payload.action = {
      label: i18n.t("errors.fix_on_provider_site", [providerName]),
      url: description.actionUrl,
    };
  }
  return payload;
}

/** The notice for `error`: title, message, and the one action in plain
 *  words, with the raw text under `detail` unless the message already is
 *  the whole story. */
export function describeFailure(error: unknown, context: FailureContext = {}): ErrorPayload {
  if (error instanceof NoVoiceSelectedError) {
    return { title: i18n.t("errors.no_voice_title"), message: i18n.t("errors.no_voice_message") };
  }
  if (error instanceof ProviderDisabledError) {
    return {
      title: i18n.t("errors.provider_disabled_title"),
      message: i18n.t("errors.provider_disabled_message"),
    };
  }

  const { provider, description = genericDescription(error) } = attribute(error, context);
  if (description) return { ...notice(provider, description), detail: detailOf(error) };
  if (isNotice(error)) return { title: i18n.t("errors.read_failed_title"), message: error.message };
  return { ...notice(provider, { kind: "unknown" }), detail: detailOf(error) };
}

/** The raw text, minus any secret a provider echoed back: the detail reaches
 *  the bug report form, and the user's key must not travel with it. */
function detailOf(error: unknown): string {
  return redactSecrets(String(error));
}

/**
 * Surface an error to the user: content-script toast on the active tab plus a
 * popup event for its banner. Never throws.
 */
export async function surfaceError(error: unknown, context: FailureContext = {}): Promise<void> {
  const payload = describeFailure(error, context);

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) emit("content", "setError", payload, { tabId: tab.id });
  } catch {
    // No active tab (e.g. chrome:// page); the popup event below still lands.
  }
  emit("popup", "backgroundError", payload);
}
