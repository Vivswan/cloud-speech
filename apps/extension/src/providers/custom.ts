import { PROVIDER_COLORS } from "@cloud-speech/constants";
import { audioBytes, ProviderHttpError, providerHttpError } from "@/lib/provider-http";
import { chunkText, isSSML, stripSsmlTags } from "@/lib/text";
import { concatBytes, mapWithConcurrency } from "@/lib/tts";
import {
  isQuotaExhaustedDetail,
  OPENAI_VOICE_NAMES,
  toOpenAiResponseFormat,
} from "./openai-protocol";
import {
  DEFAULT_RANGES,
  effectiveFormat,
  FORMAT_MP3,
  FORMAT_OGG_OPUS,
  hasAllCredentialFields,
  MULTILINGUAL,
  type NormalizedVoice,
  type SynthResult,
  type TtsProvider,
} from "./types";

// Any server speaking OpenAI's audio API at a user-supplied base URL: local engines (LocalAI,
// Speaches, openedai-speech), hosted gateways (Groq, DeepInfra), and LiteLLM proxying other
// clouds behind the same endpoint shape.

/** Sent as `model` when the user leaves the model field empty; most compatible servers alias OpenAI's model names. */
const DEFAULT_CUSTOM_MODEL = "tts-1";

// User-supplied servers hang in ways the big clouds do not (wrong port, firewalled localhost);
// these deadlines turn a hung server into a typed error instead of a hang. Synthesis gets a
// generous one: local CPU engines run slower than real time.
const PROBE_TIMEOUT_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const SYNTHESIS_TIMEOUT_MS = 300_000;

function deadline(ms: number, signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Trailing slashes, query strings, and fragments stripped so `${base}/audio/speech` lands on the
 *  endpoint path. Auth belongs in the API key field, not the URL. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    return (url.origin + url.pathname).replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

/** Deduplicated: repeated names would collide as picker row keys. */
export function parseCsvList(value: string | undefined): string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    ),
  ];
}

/** Each model becomes its own row per voice in the picker; the user is never bound to one model. */
export function parseModelsList(model: string | undefined): [string, ...string[]] {
  const [first, ...rest] = parseCsvList(model);
  return first === undefined ? [DEFAULT_CUSTOM_MODEL] : [first, ...rest];
}

function authHeaders(credentials: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = credentials.apiKey?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function toVoices(names: readonly string[], models: [string, ...string[]]): NormalizedVoice[] {
  return [...new Set(names)].map((name) => ({
    id: name,
    providerId: "custom",
    // Verbatim: server voice names (af_bella, en-US-Wavenet-D) are the identifiers users know.
    displayName: name,
    languageCodes: [MULTILINGUAL],
    gender: "Neutral",
    models,
  }));
}

export const custom: TtsProvider = {
  id: "custom",
  labelKey: "providers.custom.name",
  color: PROVIDER_COLORS.custom,

  credentialSchema: [
    {
      key: "baseUrl",
      labelKey: "providers.custom.baseUrl",
      placeholder: "http://localhost:4000/v1",
      type: "text",
      format: "url",
      stripSuffixes: ["/audio/speech", "/audio/voices"],
    },
    {
      key: "apiKey",
      labelKey: "providers.custom.apiKey",
      placeholder: "sk-...",
      type: "password",
      optional: true,
    },
    {
      key: "voices",
      labelKey: "providers.custom.voices",
      placeholder: "alloy, af_bella, en-US-Wavenet-D",
      type: "text",
      optional: true,
    },
    {
      key: "model",
      labelKey: "providers.custom.model",
      placeholder: `${DEFAULT_CUSTOM_MODEL}, gpt-4o-mini-tts`,
      type: "text",
      optional: true,
    },
  ],

  models: [{ value: DEFAULT_CUSTOM_MODEL, labelKey: "models.tts_1" }],

  audioFormats: [FORMAT_MP3, FORMAT_OGG_OPUS],

  limits: { maxChars: 4096, concurrency: 2 },

  hasCredentials(credentials) {
    return hasAllCredentialFields(this.credentialSchema, credentials);
  },

  async validateAndFetchVoices(credentials, signal) {
    const base = normalizeBaseUrl(credentials.baseUrl ?? "");
    if (!base) throw new Error("No server URL configured");
    // Probed with the first voice fetchVoices returns, so a listed or discovered name is tried before
    // the alias "alloy", which a Kokoro server exposing only af_* names rejects.
    const voices = await this.fetchVoices(credentials, signal);
    const voice = voices[0]?.id;
    if (!voice) throw new Error("No voices available to probe");
    const response = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: authHeaders(credentials),
      body: JSON.stringify({
        model: parseModelsList(credentials.model)[0],
        voice,
        input: "Hi",
        response_format: "mp3",
      }),
      signal: deadline(PROBE_TIMEOUT_MS, signal),
    });
    await audioBytes("custom", "validation", response);
    return voices;
  },

  async fetchVoices(credentials, signal) {
    const base = normalizeBaseUrl(credentials.baseUrl ?? "");
    const models = parseModelsList(credentials.model);

    // The user's explicit list always wins: it is the only signal that works against every server.
    const listed = parseCsvList(credentials.voices);
    if (listed.length > 0) return toVoices(listed, models);

    // `GET /audio/voices` is a convention (Kokoro-FastAPI, Speaches, openedai-speech), not OpenAI's
    // API. A server without it, or one advertising no voices, falls back to the alias names; a
    // transient failure must reject instead, so the voice cache keeps the last-good list rather than
    // swapping the user's voices and selection for the aliases.
    if (base) {
      const response = await fetch(`${base}/audio/voices`, {
        headers: authHeaders(credentials),
        signal: deadline(DISCOVERY_TIMEOUT_MS, signal),
      });
      if (response.ok) {
        // text() outside the try so transient body-read failures still reject.
        const text = await response.text();
        let data: { voices?: unknown } | undefined;
        try {
          data = JSON.parse(text) as { voices?: unknown };
        } catch {
          // Not JSON: this server has no discovery endpoint.
        }
        if (data && Array.isArray(data.voices)) {
          const names = data.voices.filter((v): v is string => typeof v === "string" && !!v);
          if (names.length > 0) return toVoices(names, models);
        }
      } else if (![404, 405, 501].includes(response.status)) {
        // 401/403/429 and the other 5xx are auth or server trouble, not "no such endpoint": reject so the caller keeps its cache.
        throw await providerHttpError("custom", "voices", response);
      }
    }

    return toVoices(OPENAI_VOICE_NAMES, models);
  },

  async synthesize(args): Promise<SynthResult> {
    const base = normalizeBaseUrl(args.credentials.baseUrl ?? "");
    if (!base) throw new Error("No server URL configured");

    const chunks = chunkText(args.text, this.limits.maxChars);
    const format = effectiveFormat(this.audioFormats, args.encoding, chunks.length);

    const synthesizeChunk = async (chunk: string): Promise<Uint8Array> => {
      const response = await fetch(`${base}/audio/speech`, {
        method: "POST",
        headers: authHeaders(args.credentials),
        body: JSON.stringify({
          model: args.model,
          voice: args.voiceId,
          // No SSML path in this API; strip markup or it gets spoken aloud.
          input: isSSML(chunk) ? stripSsmlTags(chunk) : chunk,
          response_format: toOpenAiResponseFormat(format.id),
          speed: args.speed,
        }),
        signal: deadline(SYNTHESIS_TIMEOUT_MS, args.signal),
      });
      return audioBytes("custom", "synthesis", response);
    };
    const byteChunks = await mapWithConcurrency(
      chunks,
      this.limits.concurrency,
      synthesizeChunk,
      args.signal,
      this,
    );

    return {
      bytes: concatBytes(byteChunks),
      mimeType: format.mimeType,
      extension: format.extension,
    };
  },

  supportsSpeed() {
    // Sent on every request; servers that ignore it degrade gracefully.
    return true;
  },
  supportsPitch() {
    return false;
  },
  supportsVolume() {
    return false;
  },
  supportsStyle() {
    return false;
  },
  supportsSSML() {
    return false;
  },
  ranges() {
    return {
      ...DEFAULT_RANGES,
      speed: { min: 0.25, max: 4, default: 1, step: 0.05 },
    };
  },

  // The URL is user-supplied: a typo or a stopped server is as likely as the internet, and the
  // failure looks the same.
  unreachableMessageKey: "errors.unreachable_server_message",
  describeError(error) {
    if (!(error instanceof ProviderHttpError)) return undefined;
    if (error.status === 429 && isQuotaExhaustedDetail(error.detail)) {
      return { kind: "quota_exhausted" };
    }
    // A speech route that answers 404 about the model or voice knows speech; the Settings lists are wrong.
    if ((error.status === 404 || error.status === 405) && /\b(model|voice)\b/i.test(error.detail)) {
      return { kind: "request_refused", messageKey: "errors.server_lists_message" };
    }
    // No speech route at that URL: a 404/405, or a 2xx web page or JSON payload where audio should have been.
    if (error.status < 400 || error.status === 404 || error.status === 405) {
      return { kind: "request_refused", messageKey: "errors.server_endpoint_message" };
    }
    return undefined;
  },
};
