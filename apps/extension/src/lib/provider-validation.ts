import { z } from "zod";
import type { NormalizedVoice, TtsProvider } from "@/providers/types";
import { isAbortError } from "./slot";

export const VALIDATION_FAILURE_CODES = [
  "authentication",
  "permission",
  "region",
  "quota",
  "network",
  "storage",
  "unknown",
] as const;

export type ValidationFailureCode = (typeof VALIDATION_FAILURE_CODES)[number];

export const ProviderValidationResultSchema = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true) }),
  z.object({
    ok: z.literal(false),
    code: z.enum(VALIDATION_FAILURE_CODES),
    detail: z.string().optional(),
  }),
]);

export type ProviderValidationResult = z.infer<typeof ProviderValidationResultSchema>;

type ValidationPhase = "provider" | "storage";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function statusFromError(error: unknown): number | undefined {
  const record = asRecord(error);
  if (!record) return undefined;

  for (const value of [record.status, record.statusCode]) {
    if (typeof value === "number") return value;
  }

  const metadata = asRecord(record.$metadata);
  if (typeof metadata?.httpStatusCode === "number") return metadata.httpStatusCode;

  const message = stringValue(record.message);
  const statusMatch = message?.match(/\b([45]\d\d)\b/);
  return statusMatch?.[1] ? Number(statusMatch[1]) : undefined;
}

function rawErrorText(error: unknown): string {
  const record = asRecord(error);
  const name = stringValue(record?.name);
  const code = stringValue(record?.code);
  const message = stringValue(record?.message) ?? (typeof error === "string" ? error : undefined);
  const status = statusFromError(error);
  return [
    code ?? (name === "Error" ? undefined : name),
    status ? `HTTP ${status}` : undefined,
    message,
  ]
    .filter(Boolean)
    .join(": ");
}

function stripUrlSecrets(value: string): string {
  return value.replace(/\b(?:https?|wss?):\/\/[^\s)'"<>]+/gi, (candidate) => {
    try {
      const url = new URL(candidate);
      return `${url.origin}${url.pathname}`;
    } catch {
      return candidate.replace(/[?#].*$/, "");
    }
  });
}

/** A diagnostic that is safe to show in the popup or write to logs. Secrets
 *  are redacted but the text is NEVER truncated: the user must always be
 *  able to read the provider's full error. */
export function sanitizeValidationDetail(
  error: unknown,
  provider: TtsProvider,
  credentials: Record<string, string>,
): string | undefined {
  let detail = rawErrorText(error).replace(/\s+/g, " ").trim();
  if (!detail) return undefined;

  detail = stripUrlSecrets(detail);
  const credentialKeys = new Set(provider.credentialSchema.map((field) => field.key));
  const credentialValues = Object.entries(credentials)
    .filter(([key, value]) => credentialKeys.has(key) && value.length >= 4)
    .map(([, value]) => value)
    .sort((a, b) => b.length - a.length);
  for (const value of credentialValues) detail = detail.split(value).join("[redacted]");

  detail = detail
    .replace(/\bBearer\s+[^\s,;)]+/gi, "Bearer [redacted]")
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, "[redacted]")
    .replace(
      /\b(authorization|api[-_ ]?key|token|signature|secret)\s*[:=]\s*[^\s,;)]+/gi,
      "$1=[redacted]",
    )
    .replace(/[A-Za-z0-9+/=_-]{40,}/g, "[redacted]");

  return detail;
}

export function classifyValidationError(
  error: unknown,
  provider: TtsProvider,
  credentials: Record<string, string>,
  phase: ValidationPhase = "provider",
): Exclude<ProviderValidationResult, { ok: true }> {
  const detail = sanitizeValidationDetail(error, provider, credentials);
  if (phase === "storage") return { ok: false, code: "storage", detail };

  const raw = rawErrorText(error).toLowerCase();
  const status = statusFromError(error);
  let code: ValidationFailureCode = "unknown";

  if (/quota|throttl|rate.?limit|too many requests/.test(raw) || status === 429) {
    code = "quota";
  } else if (
    /invalidclienttokenid|signaturedoesnotmatch|unrecognizedclient|invalid.*(?:key|token|credential)|authentication/.test(
      raw,
    ) ||
    status === 401
  ) {
    code = "authentication";
  } else if (/accessdenied|forbidden|not authorized|permission/.test(raw) || status === 403) {
    code = "permission";
  } else if (
    /invalid region|unknown region|region.*(?:missing|mismatch|required|invalid)|invalid endpoint/.test(
      raw,
    )
  ) {
    code = "region";
  } else if (
    /failed to fetch|network|websocket|timed? ?out|timeout|aborterror|enotfound|econn|connection/.test(
      raw,
    )
  ) {
    code = "network";
  }

  return { ok: false, code, detail };
}

/** A validation overtaken by a newer Save & test for the same provider: its
 *  request was cancelled (or its commit refused), and nothing was stored. */
const SUPERSEDED: ProviderValidationResult = {
  ok: false,
  code: "unknown",
  detail: "superseded",
};

/** Validate exactly once, then commit only the proven credentials and voices.
 *  `commit` decides, under its own write lock, whether this candidate is
 *  still the newest one; only "persisted" counts as success. */
export async function validateProviderCandidate(
  provider: TtsProvider,
  credentials: Record<string, string>,
  commit: (voices: NormalizedVoice[]) => Promise<"persisted" | "superseded">,
  signal?: AbortSignal,
): Promise<ProviderValidationResult> {
  const missingFields = provider.credentialSchema
    .filter((field) => !field.optional && !credentials[field.key]?.trim())
    .map((field) => field.key);
  if (missingFields.length > 0) {
    return {
      ok: false,
      code: missingFields.includes("region") ? "region" : "authentication",
      detail: `Missing required field${missingFields.length === 1 ? "" : "s"}: ${missingFields.join(", ")}`,
    };
  }

  let voices: NormalizedVoice[];
  try {
    voices = await provider.validateAndFetchVoices(credentials, signal);
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
