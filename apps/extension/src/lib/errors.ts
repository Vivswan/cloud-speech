import { PROVIDER_NAMES, type ProviderId } from "@cloud-speech/constants";
import { browser } from "#imports";
import { i18n, type MessageKey, tDynamic } from "@/lib/i18n-runtime";
import { getProvider, providerList } from "@/providers";
import type { ErrorDescription, FailureKind, TtsProvider } from "@/providers/types";
import { type BackgroundErrorEvent, type ErrorPayload, emit } from "./protocol";
import { failureKindForStatus, isNetworkFailure, ProviderHttpError } from "./provider-http";
import { credentialsFor } from "./provider-state";
import { redactCredentials, redactSecrets, sanitizeDetail } from "./provider-validation";
import { getSettings, type Settings } from "./storage";
import { NoVoiceSelectedError, ProviderDisabledError } from "./synthesize";
import { UserFacingError } from "./user-facing-error";

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

interface DescribedFailure {
  payload: ErrorPayload;
  /** The provider the failure was attributed to; absent for the failures
   *  the extension explains itself (no voice, no selection). */
  providerId?: ProviderId;
}

function describe(error: unknown, context: FailureContext): DescribedFailure {
  if (error instanceof NoVoiceSelectedError) {
    return {
      payload: {
        title: i18n.t("errors.no_voice_title"),
        message: i18n.t("errors.no_voice_message"),
      },
    };
  }
  if (error instanceof ProviderDisabledError) {
    return {
      payload: {
        title: i18n.t("errors.provider_disabled_title"),
        message: i18n.t("errors.provider_disabled_message"),
      },
    };
  }
  if (error instanceof UserFacingError) {
    const payload: ErrorPayload = {
      title: i18n.t(error.titleKey),
      message: i18n.t(error.messageKey),
    };
    if (error.action) {
      payload.action = { label: i18n.t(error.action.labelKey), url: error.action.url };
    }
    return { payload };
  }

  const { provider, description = genericDescription(error) } = attribute(error, context);
  const payload = {
    ...notice(provider, description ?? { kind: "unknown" }),
    detail: detailOf(error),
  };
  return provider ? { payload, providerId: provider.id } : { payload };
}

/** The notice for `error`: title, message, and the one action in plain
 *  words, with the raw text under `detail` unless the message already is
 *  the whole story. */
export function describeFailure(error: unknown, context: FailureContext = {}): ErrorPayload {
  return describe(error, context).payload;
}

/** The raw text, minus any secret a provider echoed back by shape: the detail
 *  reaches the bug report form, and the user's key must not travel with it.
 *  surfaceError also blanks the configured credential values themselves. */
function detailOf(error: unknown): string {
  return redactSecrets(String(error));
}

/** `payload` with every configured credential value blanked from every
 *  field, whichever provider echoed it: a server that quotes the key it
 *  rejected would otherwise put it in Details and in the bug report's logs
 *  field, and a provider reading its own error body can carry server text
 *  into the sentence and the fix link. A fix link that carries a value is
 *  dropped: blanked, it would lead nowhere. The detail is rebuilt from the
 *  raw text so the values and the shape rules are found on the same intact
 *  text. Reading the settings can fail; the shape-redacted payload is then
 *  what the user sees. */
async function withoutCredentials(error: unknown, payload: ErrorPayload): Promise<ErrorPayload> {
  let settings: Settings;
  try {
    settings = await getSettings();
  } catch {
    return payload;
  }
  const configured = providerList.map(
    (provider) => [provider, credentialsFor(settings, provider.id)] as const,
  );
  const blank = (text: string) => redactCredentials(text, configured);
  const safe: ErrorPayload = { title: blank(payload.title), message: blank(payload.message) };
  if (payload.action && blank(payload.action.url) === payload.action.url) {
    safe.action = { label: blank(payload.action.label), url: payload.action.url };
  }
  if (payload.detail !== undefined) safe.detail = sanitizeDetail(String(error), configured);
  return safe;
}

/**
 * Surface an error to the user: content-script toast on the active tab plus a
 * popup event for its banner. Never throws.
 */
export async function surfaceError(error: unknown, context: FailureContext = {}): Promise<void> {
  const described = describe(error, context);
  const payload = await withoutCredentials(error, described.payload);

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) emit("content", "setError", payload, { tabId: tab.id });
  } catch {
    // No active tab (e.g. chrome:// page); the popup event below still lands.
  }
  // The popup also learns which provider failed, for the bug report.
  const event: BackgroundErrorEvent = described.providerId
    ? { ...payload, providerId: described.providerId }
    : payload;
  emit("popup", "backgroundError", event);
}
