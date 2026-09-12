import { PROVIDER_NAMES, type ProviderId } from "@cloud-speech/constants";
import { browser } from "#imports";
import { i18n, type MessageKey, tDynamic } from "@/lib/i18n-runtime";
import { getProvider, providerList } from "@/providers";
import type { ErrorDescription, FailureKind, TtsProvider } from "@/providers/types";
import { errorText } from "./error-text";
import { type BackgroundErrorEvent, type ErrorPayload, type ErrorToast, emit } from "./protocol";
import { failureKindForStatus, isNetworkFailure, ProviderHttpError } from "./provider-http";
import { credentialsFor } from "./provider-state";
import { redactCredentials, redactSecrets, sanitizeDetail } from "./provider-validation";
import { getSettings, type Settings } from "./storage";
import { NoVoiceSelectedError, ProviderDisabledError } from "./synthesize";
import { UserFacingError } from "./user-facing-error";

// Failure classes are provider-neutral; a provider only recognizes its own
// error bodies (TtsProvider.describeError). Nothing here switches on a
// provider id.

/** What the user asked for when it failed; the notice's title names it. */
export type FailureOperation = "read" | "download" | "preview" | "scan";

/** What the error itself may not carry: a fetch that never got an answer
 *  names no provider, so without `providerId` the notice names none; without
 *  `operation` it is titled as a read. */
export interface FailureContext {
  providerId?: ProviderId;
  operation?: FailureOperation;
}

const OPERATION_TITLE: Record<FailureOperation, MessageKey> = {
  read: "errors.read_failed_title",
  download: "errors.download_failed_title",
  preview: "errors.preview_failed_title",
  // A scan runs inside Save & test, so its notice borrows that verdict's
  // generic "check failed" title.
  scan: "settings.validation_unknown_title",
};

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

function genericDescription(error: unknown): ErrorDescription | undefined {
  if (error instanceof ProviderHttpError) return { kind: failureKindForStatus(error.status) };
  if (isNetworkFailure(error)) return { kind: "unreachable" };
  return undefined;
}

type PlainWords = Omit<ErrorPayload, "detail">;

/** A surface with a title of its own (the Save & test verdict) shows these
 *  under that title. */
export type ReadingAdvice = Omit<PlainWords, "title">;

export function readingAdvice(
  provider: TtsProvider | undefined,
  description: ErrorDescription,
): ReadingAdvice {
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
  const advice: ReadingAdvice = { message };
  if (description.actionUrl && providerName) {
    advice.action = {
      label: i18n.t("errors.fix_on_provider_site", [providerName]),
      url: description.actionUrl,
    };
  }
  return advice;
}

function notice(
  provider: TtsProvider | undefined,
  description: ErrorDescription,
  operation: FailureOperation,
): PlainWords {
  return { title: i18n.t(OPERATION_TITLE[operation]), ...readingAdvice(provider, description) };
}

interface DescribedFailure {
  words: PlainWords;
  /** Before any redaction: the thrower's own statement for the failures the
   *  extension explains itself, the error's text for everything else. */
  detail: string;
  /** Absent for the failures the extension explains itself (no voice, no
   *  selection). */
  providerId?: ProviderId;
}

function describe(error: unknown, context: FailureContext): DescribedFailure {
  if (error instanceof NoVoiceSelectedError) {
    return {
      words: {
        title: i18n.t("errors.no_voice_title"),
        message: i18n.t("errors.no_voice_message"),
      },
      detail: String(error),
    };
  }
  if (error instanceof ProviderDisabledError) {
    return {
      words: {
        title: i18n.t("errors.provider_disabled_title"),
        message: i18n.t("errors.provider_disabled_message"),
      },
      detail: String(error),
    };
  }
  if (error instanceof UserFacingError) {
    const words: PlainWords = {
      title: i18n.t(error.titleKey),
      message: i18n.t(error.messageKey),
    };
    if (error.action) {
      words.action = { label: i18n.t(error.action.labelKey), url: error.action.url };
    }
    return { words, detail: error.detail };
  }

  const { provider, description = genericDescription(error) } = attribute(error, context);
  const words = notice(provider, description ?? { kind: "unknown" }, context.operation ?? "read");
  const detail = errorText(error);
  return provider ? { words, detail, providerId: provider.id } : { words, detail };
}

/** Detail made safe by shape alone (redactSecrets), for a caller without the
 *  settings at hand. */
function payloadOf({ words, detail }: DescribedFailure): ErrorPayload {
  return { ...words, detail: redactSecrets(detail) };
}

/** Secrets a provider echoed back are blanked by shape: the detail reaches
 *  the bug report form, and the user's key must not travel with it.
 *  surfaceError also blanks the configured credential values themselves. */
export function describeFailure(error: unknown, context: FailureContext = {}): ErrorPayload {
  return payloadOf(describe(error, context));
}

/** A server that quotes the key it rejected would put it in Details and in
 *  the bug report, and a provider reading its own body can carry server text
 *  into the sentence and the fix link, so the configured values of every
 *  provider are blanked from every field (a value under four characters only
 *  as a whole token; see configuredSpans in lib/provider-validation.ts).
 *
 *  fix link carrying a value  -> dropped; blanked, it would lead nowhere
 *  settings unreadable        -> the shape-redacted payload is what the user sees
 */
async function withoutCredentials(described: DescribedFailure): Promise<ErrorPayload> {
  let settings: Settings;
  try {
    settings = await getSettings();
  } catch {
    return payloadOf(described);
  }
  const configured = providerList.map(
    (provider) => [provider, credentialsFor(settings, provider.id)] as const,
  );
  const blank = (text: string) => redactCredentials(text, configured);
  const { words, detail } = described;
  const safe: ErrorPayload = {
    title: blank(words.title),
    message: blank(words.message),
    detail: sanitizeDetail(detail, configured),
  };
  if (words.action && blank(words.action.url) === words.action.url) {
    safe.action = { label: blank(words.action.label), url: words.action.url };
  }
  return safe;
}

/** What surfaceError shows and what a voice issue records, so the picker
 *  shows the failure exactly as the user saw it. */
export function describeFailureWithoutCredentials(
  error: unknown,
  context: FailureContext = {},
): Promise<ErrorPayload> {
  return withoutCredentials(describe(error, context));
}

/** Toast on the active tab plus a popup banner event. Never throws. */
export async function surfaceError(error: unknown, context: FailureContext = {}): Promise<void> {
  const described = describe(error, context);
  const payload = await withoutCredentials(described);

  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    // The page has no i18n runtime, so the toast's two controls are labelled
    // here, in the display language the user chose, like the notice itself.
    const toast: ErrorToast = {
      ...payload,
      labels: { details: i18n.t("errors.details"), dismiss: i18n.t("common.dismiss") },
    };
    if (tab?.id) emit("content", "setError", toast, { tabId: tab.id });
  } catch {
    // No active tab (e.g. chrome:// page); the popup event below still lands.
  }
  // The popup also learns which provider failed, for the bug report.
  const event: BackgroundErrorEvent = described.providerId
    ? { ...payload, providerId: described.providerId }
    : payload;
  emit("popup", "backgroundError", event);
}
