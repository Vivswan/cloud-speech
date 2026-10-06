import { concatBytes, mapWithConcurrency } from "@/lib/audio/tts";
import { audioBytes } from "@/lib/messaging/provider-http";
import { chunkText, isSSML, stripSsmlTags } from "@/lib/text/text";
import {
  DEFAULT_RANGES,
  effectiveFormat,
  FORMAT_OGG_OPUS,
  type SynthesizeArgs,
  type SynthResult,
  type TtsProvider,
} from "./types";

// OpenAI's audio API vocabulary and request path, shared by the openai and custom providers. Not a
// registry entry.

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

export interface OpenAiSpeechEndpoint {
  base: string;
  headers: Record<string, string>;
  /** Per-request signal, derived from the synthesis signal; the custom provider adds a deadline. */
  signalFor?(signal: AbortSignal): AbortSignal;
}

export async function synthesizeOpenAiSpeech(
  provider: TtsProvider,
  args: SynthesizeArgs,
  endpoint: OpenAiSpeechEndpoint,
): Promise<SynthResult> {
  const chunks = chunkText(args.text, provider.limits.maxChars);
  const format = effectiveFormat(provider.audioFormats, args.encoding, chunks.length);

  const synthesizeChunk = async (chunk: string): Promise<Uint8Array> => {
    const response = await fetch(`${endpoint.base}/audio/speech`, {
      method: "POST",
      headers: endpoint.headers,
      body: JSON.stringify({
        model: args.model,
        voice: args.voiceId,
        // No SSML path in this API; strip markup or it gets spoken aloud.
        input: isSSML(chunk) ? stripSsmlTags(chunk) : chunk,
        response_format: toOpenAiResponseFormat(format.id),
        speed: args.speed,
      }),
      signal: endpoint.signalFor ? endpoint.signalFor(args.signal) : args.signal,
    });
    return audioBytes(provider.id, "synthesis", response);
  };
  const byteChunks = await mapWithConcurrency(
    chunks,
    provider.limits.concurrency,
    synthesizeChunk,
    args.signal,
    provider,
  );

  return {
    bytes: concatBytes(byteChunks),
    mimeType: format.mimeType,
    extension: format.extension,
  };
}

/** `speed` is the API's one prosody knob, sent on every request; servers that ignore it degrade
 *  gracefully. */
export const OPENAI_PROTOCOL_CAPABILITIES = {
  supportsSpeed: () => true,
  supportsPitch: () => false,
  supportsVolume: () => false,
  supportsStyle: () => false,
  supportsSSML: () => false,
  ranges: () => ({
    ...DEFAULT_RANGES,
    speed: { min: 0.25, max: 4, default: 1, step: 0.05 },
  }),
} satisfies Pick<
  TtsProvider,
  "supportsSpeed" | "supportsPitch" | "supportsVolume" | "supportsStyle" | "supportsSSML" | "ranges"
>;
