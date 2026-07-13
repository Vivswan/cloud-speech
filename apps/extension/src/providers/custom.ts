import { guideUrl } from "@/lib/guide";
import { chunkText, isSSML, stripSsmlTags } from "@/lib/text";
import { concatBytes, mapWithConcurrency } from "@/lib/tts";
import {
  DEFAULT_RANGES,
  effectiveFormat,
  hasAllCredentialFields,
  type NormalizedVoice,
  type SynthResult,
  type TtsProvider,
} from "./types";

// Any server that speaks OpenAI's audio API at a user-supplied base URL:
// local engines (LocalAI, Speaches, openedai-speech), hosted
// gateways (Groq, DeepInfra), and LiteLLM, which proxies OpenAI,
// Azure, Polly, Vertex/Gemini, ElevenLabs, and MiniMax behind this one
// endpoint shape. The API key is OPTIONAL: local servers usually need none.

const CREDENTIAL_HELP_URL = guideUrl("setup/custom");

/** Sent as `model` when the user leaves the model field empty; most
 *  compatible servers alias OpenAI's model names. */
const DEFAULT_MODEL = "tts-1";

// User-supplied servers hang in ways the big clouds don't (wrong port,
// firewalled localhost, a proxy that drops packets); without deadlines the
// Save & test spinner and queued synthesis retries never resolve. Synthesis
// gets a generous one: local CPU engines run slower than real time.
const PROBE_TIMEOUT_MS = 15_000;
const DISCOVERY_TIMEOUT_MS = 10_000;
const SYNTHESIS_TIMEOUT_MS = 300_000;

// Most servers alias OpenAI's voice names: the fallback when the server has
// no discovery endpoint and the user listed no voices.
const FALLBACK_VOICE_NAMES = [
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

/** Trailing slashes, query strings, and fragments stripped so
 *  `${base}/audio/speech` always lands on the endpoint path. Auth belongs in
 *  the API key field, not the URL. */
export function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  try {
    const url = new URL(trimmed);
    return (url.origin + url.pathname).replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/[?#].*$/, "").replace(/\/+$/, "");
  }
}

/** The optional comma-separated `voices` and `models` credentials, parsed.
 *  Deduplicated: repeated names would collide as picker row keys. */
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

/** Every model the user listed, or the widely-aliased default. Each becomes
 *  its own row per voice in the picker; never bind the user to one model. */
export function parseModelsList(model: string | undefined): string[] {
  const listed = parseCsvList(model);
  return listed.length > 0 ? listed : [DEFAULT_MODEL];
}

function authHeaders(credentials: Record<string, string>): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const apiKey = credentials.apiKey?.trim();
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return headers;
}

function toVoices(names: string[], models: string[]): NormalizedVoice[] {
  return [...new Set(names)].map((name) => ({
    id: name,
    providerId: "custom",
    // Verbatim: server voice names (af_bella, en-US-Wavenet-D...) are the
    // identifiers users know; prettifying them would only obscure.
    displayName: name,
    languageCodes: ["multilingual"],
    gender: "Neutral",
    models,
  }));
}

/** A 2xx from a catch-all route can be an HTML page or a JSON error payload.
 *  Neither is playable, and accepting it here only defers the failure to the
 *  offscreen player where the message is far worse. */
function isNonAudioResponse(response: Response): boolean {
  const type = response.headers.get("content-type")?.toLowerCase() ?? "";
  return type.includes("text/html") || type.includes("application/json");
}

/** Readable failures across heterogeneous servers: status + FULL body. Never
 *  truncated: the server's error text is often the only clue the user gets. */
async function synthesisError(response: Response): Promise<Error> {
  let detail = "";
  try {
    detail = (await response.text()).trim();
  } catch {
    // body unreadable; the status alone will have to do
  }
  return new Error(
    `OpenAI-compatible synthesis failed: ${response.status}${detail ? ` (${detail})` : ""}`,
  );
}

export const custom: TtsProvider = {
  id: "custom",
  labelKey: "providers.custom.name",
  color: "#64748B",

  credentialSchema: [
    {
      key: "baseUrl",
      labelKey: "providers.custom.baseUrl",
      placeholder: "http://localhost:4000/v1",
      type: "text",
      helpUrl: CREDENTIAL_HELP_URL,
      format: "url",
      // Server docs show the full endpoint URL; users paste it whole.
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
      placeholder: `${DEFAULT_MODEL}, gpt-4o-mini-tts`,
      type: "text",
      optional: true,
    },
  ],

  models: [{ value: DEFAULT_MODEL, labelKey: "models.tts_1" }],

  audioFormats: [
    {
      id: "MP3",
      mimeType: "audio/mpeg",
      extension: "mp3",
      stitchable: true,
      forDownload: true,
      forReadAloud: true,
    },
    {
      id: "OGG_OPUS",
      mimeType: "audio/ogg",
      extension: "ogg",
      stitchable: false,
      forDownload: false,
      forReadAloud: true,
    },
  ],

  limits: { maxChars: 4096, concurrency: 2 },

  hasCredentials(credentials) {
    return hasAllCredentialFields(this.credentialSchema, credentials);
  },

  async validateAndFetchVoices(credentials) {
    const base = normalizeBaseUrl(credentials.baseUrl ?? "");
    if (!base) throw new Error("No server URL configured");
    // Probe the actual speech endpoint, the one capability that matters.
    // The probe voice must be one the server ACTUALLY has: a Kokoro server
    // exposing only af_* names would reject "alloy" and fail Save & test, so
    // ask fetchVoices first (explicit list, then discovery, then fallback).
    const voices = await this.fetchVoices(credentials);
    const voice = parseCsvList(credentials.voices)[0] ?? voices[0]?.id ?? FALLBACK_VOICE_NAMES[0];
    const response = await fetch(`${base}/audio/speech`, {
      method: "POST",
      headers: authHeaders(credentials),
      body: JSON.stringify({
        model: parseModelsList(credentials.model)[0],
        voice,
        input: "Hi",
        response_format: "mp3",
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok || isNonAudioResponse(response)) throw await synthesisError(response);
    if ((await response.arrayBuffer()).byteLength === 0) {
      throw new Error("OpenAI-compatible validation returned an empty response");
    }
    return voices;
  },

  async fetchVoices(credentials) {
    const base = normalizeBaseUrl(credentials.baseUrl ?? "");
    const models = parseModelsList(credentials.model);

    // The user's explicit list always wins: it's the only signal that works
    // against EVERY server.
    const listed = parseCsvList(credentials.voices);
    if (listed.length > 0) return toVoices(listed, models);

    // Discovery: `GET /audio/voices` is a common convention (Kokoro-FastAPI,
    // Speaches, openedai-speech), not part of OpenAI's API. Only a server
    // that lacks the convention falls back to the OpenAI-alias names;
    // transient failures (network, timeout, 5xx) must REJECT instead, so the
    // voice cache keeps the last-good list rather than silently swapping the
    // user's real voices (and their selection) for the aliases.
    if (base) {
      const response = await fetch(`${base}/audio/voices`, {
        headers: authHeaders(credentials),
        signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
      });
      if (response.ok) {
        let data: { voices?: unknown } | undefined;
        try {
          data = (await response.json()) as { voices?: unknown };
        } catch (error) {
          // A 200 body that isn't JSON is "no discovery here"; a network
          // failure while reading it is transient and must reject.
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (data && Array.isArray(data.voices)) {
          const names = data.voices.filter((v): v is string => typeof v === "string" && !!v);
          if (names.length > 0) return toVoices(names, models);
        }
      } else if (![404, 405, 501].includes(response.status)) {
        // Anything else (401/403/429/5xx) is auth or server trouble, not
        // "no such endpoint": reject so the caller keeps its cache.
        throw new Error(`Voice discovery failed: ${response.status}`);
      }
    }

    return toVoices(FALLBACK_VOICE_NAMES, models);
  },

  async synthesize(args): Promise<SynthResult> {
    const base = normalizeBaseUrl(args.credentials.baseUrl ?? "");
    if (!base) throw new Error("No server URL configured");

    const chunks = chunkText(args.text, this.limits.maxChars);
    // Non-stitchable containers (Ogg) can't be byte-concatenated, so fall back
    // to a stitchable format when the text needed more than one chunk.
    const format = effectiveFormat(this.audioFormats, args.encoding, chunks.length);
    if (!format) throw new Error("No audio format available");

    const byteChunks = await mapWithConcurrency(chunks, this.limits.concurrency, async (chunk) => {
      const response = await fetch(`${base}/audio/speech`, {
        method: "POST",
        headers: authHeaders(args.credentials),
        body: JSON.stringify({
          model: args.model,
          voice: args.voiceId,
          // No SSML path in this API; strip markup or it gets spoken aloud.
          input: isSSML(chunk) ? stripSsmlTags(chunk) : chunk,
          response_format: format.id === "OGG_OPUS" ? "opus" : "mp3",
          speed: args.speed,
        }),
        signal: AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS),
      });
      if (!response.ok || isNonAudioResponse(response)) throw await synthesisError(response);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new Error("OpenAI-compatible synthesis returned an empty response");
      }
      return bytes;
    });

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
};
