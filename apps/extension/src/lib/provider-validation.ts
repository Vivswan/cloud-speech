import { z } from "zod";
import {
  type ErrorDescription,
  FAILURE_KINDS,
  type FailureKind,
  type NormalizedVoice,
  type TtsProvider,
  validateAndFetchVoices,
} from "@/providers/types";
import { statusFromError, stringValue } from "./error-text";
import type { MessageKey } from "./i18n-runtime";
import { ProviderHttpError } from "./provider-http";
import { isRecord } from "./record";
import { redactCredentials, sanitizeDetail } from "./redaction";
import { retryTransient } from "./retry";
import { isAbortError } from "./slot";

export const VALIDATION_FAILURE_CODES = [
  "authentication",
  "permission",
  "region",
  "quota",
  "network",
  "storage",
  "unknown",
  /** Overtaken by a newer Save & test for the same provider: nothing was
   *  stored, and the newer one reports for both. Not a failure to show. */
  "superseded",
] as const;

export type ValidationFailureCode = (typeof VALIDATION_FAILURE_CODES)[number];

/** A locale key is a string on the wire; the generated key union is a type. */
const MessageKeySchema = z.custom<MessageKey>((value) => typeof value === "string");

const readingFields = {
  feature: z.string().optional(),
  actionUrl: z.string().optional(),
  messageKey: MessageKeySchema.optional(),
};

/** An api_disabled reading must bring the feature or a sentence of its own. */
export const ErrorDescriptionSchema: z.ZodType<ErrorDescription> = z.union([
  z.object({ kind: z.enum(FAILURE_KINDS).exclude(["api_disabled"]), ...readingFields }),
  z.object({ ...readingFields, kind: z.literal("api_disabled"), feature: z.string() }),
  z.object({ ...readingFields, kind: z.literal("api_disabled"), messageKey: MessageKeySchema }),
]);

export const ProviderValidationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(VALIDATION_FAILURE_CODES),
    detail: z.string().optional(),
    /** Present only when the provider's reading says more than the code: the
     *  verdict shows its words under the code's title, the same words the
     *  read banner shows for the same failure. */
    description: ErrorDescriptionSchema.optional(),
    /** With code "storage": the schema version of the settings a newer build
     *  saved, when that refused the write. A field rather than a reading of
     *  `detail`, whose text is redacted (a configured key that happens to be
     *  a word of the message would blank it). */
    storedVersion: z.number().int().optional(),
  }),
]);

export type ProviderValidationResult = z.infer<typeof ProviderValidationResultSchema>;

type ValidationPhase = "provider" | "storage";

/** The stored schema version a SettingsNewerError names. Read by shape:
 *  this module reaches the offscreen document through `lib/protocol.ts`, and
 *  that document must not import storage, which the class's module does. */
function newerBuildVersion(error: unknown): number | undefined {
  return isRecord(error) &&
    error.name === "SettingsNewerError" &&
    typeof error.storedVersion === "number"
    ? error.storedVersion
    : undefined;
}

function rawErrorText(error: unknown): string {
  // Self-describing: its message already names the provider, operation, and
  // status, so the SDK-error reconstruction below would only repeat them.
  if (error instanceof ProviderHttpError) return error.message;
  const record = isRecord(error) ? error : {};
  const name = stringValue(record.name);
  const code = stringValue(record.code);
  const message = stringValue(record.message) ?? (typeof error === "string" ? error : undefined);
  const status = statusFromError(error);
  return [
    code ?? (name === "Error" ? undefined : name),
    status ? `HTTP ${status}` : undefined,
    message,
  ]
    .filter(Boolean)
    .join(": ");
}

/** The diagnostic of a failed Save & test, in one line. */
export function sanitizeValidationDetail(
  error: unknown,
  provider: TtsProvider,
  credentials: Record<string, string>,
): string | undefined {
  const detail = rawErrorText(error).replace(/\s+/g, " ").trim();
  if (!detail) return undefined;
  return sanitizeDetail(detail, [[provider, credentials]]);
}

/** FailureKind has no region or permission class: a provider says those in
 *  the sentence of a key_rejected reading, and codeFor's text rules split
 *  that class into the three codes. */
const CODE_BY_KIND: Record<FailureKind, ValidationFailureCode> = {
  key_rejected: "authentication",
  api_disabled: "permission",
  quota_exhausted: "quota",
  rate_limited: "quota",
  provider_outage: "unknown",
  request_refused: "unknown",
  unreachable: "network",
  unknown: "unknown",
};

function codeByRules(raw: string, status: number | undefined): ValidationFailureCode {
  if (/quota|throttl|rate.?limit|too many requests/.test(raw) || status === 429) {
    return "quota";
  }
  if (
    /invalidclienttokenid|signaturedoesnotmatch|unrecognizedclient|invalid.*(?:key|token|credential)|authentication/.test(
      raw,
    ) ||
    status === 401
  ) {
    return "authentication";
  }
  if (/accessdenied|forbidden|not authorized|permission/.test(raw) || status === 403) {
    return "permission";
  }
  if (
    /invalid region|unknown region|region.*(?:missing|mismatch|required|invalid)|invalid endpoint/.test(
      raw,
    )
  ) {
    return "region";
  }
  if (
    /failed to fetch|network|websocket|timed? ?out|timeout|aborterror|enotfound|econn|connection/.test(
      raw,
    )
  ) {
    return "network";
  }
  return "unknown";
}

function codeFor(description: ErrorDescription, raw: string): ValidationFailureCode {
  const code = CODE_BY_KIND[description.kind];
  if (code !== "authentication") return code;
  const byText = codeByRules(raw, undefined);
  return byText === "permission" || byText === "region" ? byText : code;
}

function saysMore(description: ErrorDescription): boolean {
  return (
    description.messageKey !== undefined ||
    description.feature !== undefined ||
    description.actionUrl !== undefined
  );
}

/** A provider composes the feature and the fix link from server text, so the
 *  candidate's values are blanked from the feature and a link they would
 *  change is dropped, as surfaceError does for the banner. */
function withoutCandidate(
  description: ErrorDescription,
  provider: TtsProvider,
  credentials: Record<string, string>,
): ErrorDescription {
  const blank = (text: string) => redactCredentials(text, [[provider, credentials]]);
  const safe = { ...description };
  if (safe.feature !== undefined) safe.feature = blank(safe.feature);
  if (safe.actionUrl !== undefined && blank(safe.actionUrl) !== safe.actionUrl) {
    delete safe.actionUrl;
  }
  return safe;
}

/** The provider reads its error first: only it knows a disabled API or an
 *  exhausted quota behind a 403, or a rejected key behind an SDK exception. */
export function classifyValidationError(
  error: unknown,
  provider: TtsProvider,
  credentials: Record<string, string>,
  phase: ValidationPhase = "provider",
): Exclude<ProviderValidationResult, { ok: true }> {
  const detail = sanitizeValidationDetail(error, provider, credentials);
  if (phase === "storage") {
    const storedVersion = newerBuildVersion(error);
    return storedVersion === undefined
      ? { ok: false, code: "storage", detail }
      : { ok: false, code: "storage", detail, storedVersion };
  }

  const raw = rawErrorText(error).toLowerCase();
  const description = provider.describeError?.(error);
  if (description === undefined) {
    return { ok: false, code: codeByRules(raw, statusFromError(error)), detail };
  }
  const code = codeFor(description, raw);
  const safe = withoutCandidate(description, provider, credentials);
  return saysMore(safe)
    ? { ok: false, code, detail, description: safe }
    : { ok: false, code, detail };
}

const SUPERSEDED: ProviderValidationResult = { ok: false, code: "superseded" };

/** `commit` decides, under its own write lock, whether this candidate is
 *  still the newest; only "persisted" counts as success. */
export async function validateProviderCandidate(
  provider: TtsProvider,
  credentials: Record<string, string>,
  commit: (voices: NormalizedVoice[]) => Promise<"persisted" | "superseded">,
  signal?: AbortSignal,
): Promise<ProviderValidationResult> {
  // Superseded while the caller was still loading settings: say so, instead
  // of reporting the stale draft's missing fields.
  if (signal?.aborted) return SUPERSEDED;

  const missing = provider.credentialSchema.filter(
    (field) => !field.optional && !credentials[field.key]?.trim(),
  );
  if (missing.length > 0) {
    return {
      ok: false,
      code: missing.some((field) => field.role === "region") ? "region" : "authentication",
      detail: `Missing required field${missing.length === 1 ? "" : "s"}: ${missing.map((field) => field.key).join(", ")}`,
    };
  }

  let voices: NormalizedVoice[];
  try {
    voices = await retryTransient(
      () => validateAndFetchVoices(provider, credentials, signal),
      signal,
      provider,
    );
    if (voices.length === 0) throw new Error("Provider returned no voices");
  } catch (error) {
    if (isAbortError(error)) return SUPERSEDED;
    return classifyValidationError(error, provider, credentials);
  }

  let outcome: "persisted" | "superseded";
  try {
    outcome = await commit(voices);
  } catch (error) {
    return classifyValidationError(error, provider, credentials, "storage");
  }
  return outcome === "persisted" ? { ok: true } : SUPERSEDED;
}
