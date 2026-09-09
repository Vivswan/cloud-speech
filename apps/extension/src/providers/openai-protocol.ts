import { FORMAT_OGG_OPUS } from "./types";

// Shared vocabulary of OpenAI's audio API, used by the openai provider and
// the OpenAI-compatible custom provider. Not a registry entry.

/** OpenAI's static voice catalog (there is no voice-list API). Compatible
 *  servers commonly alias these names, so the custom provider also uses this
 *  list as its no-discovery fallback. */
export const OPENAI_VOICE_NAMES: readonly string[] = [
  "alloy",
  "ash",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
];

/** Map a canonical AudioFormat id to OpenAI's `response_format` wire value. */
export function toOpenAiResponseFormat(formatId: string): "opus" | "mp3" {
  return formatId === FORMAT_OGG_OPUS.id ? "opus" : "mp3";
}

/** OpenAI's insufficient_quota body, which shares the 429 status with plain
 *  throttling but says the account needs credit. Gateways that proxy OpenAI
 *  pass it through, so the OpenAI-compatible provider reads it too. The
 *  rate-limit body also mentions billing, so only this sentence counts. */
export function isQuotaExhaustedDetail(detail: string): boolean {
  return /exceeded your current quota/i.test(detail);
}
