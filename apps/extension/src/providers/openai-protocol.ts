import { FORMAT_OGG_OPUS } from "./types";

// OpenAI's audio API vocabulary, shared by the openai and custom providers. Not a registry entry.

/** OpenAI has no voice-list API. Compatible servers commonly alias these names, so the custom
 *  provider uses the list as its no-discovery fallback. */
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

export function toOpenAiResponseFormat(formatId: string): "opus" | "mp3" {
  return formatId === FORMAT_OGG_OPUS.id ? "opus" : "mp3";
}

/** insufficient_quota shares the 429 status with plain throttling but means the account needs
 *  credit; gateways proxying OpenAI pass it through. The rate-limit body also mentions billing,
 *  so only this sentence counts. */
export function isQuotaExhaustedDetail(detail: string): boolean {
  return /exceeded your current quota/i.test(detail);
}
