import { i18n } from "#i18n";
import { browser } from "#imports";
import { surfaceError } from "@/lib/errors";
import { type RuntimeMessage, sendToOffscreen } from "@/lib/messages";
import { migrateLegacySettings } from "@/lib/migrations";
import { ensureOffscreenDocument } from "@/lib/offscreen";
import { scanVoiceAvailability } from "@/lib/probe";
import {
  clearVoiceIssue,
  getSettings,
  recordVoiceIssue,
  type Settings,
  updateSettingsWith,
  voiceIssueKey,
} from "@/lib/storage";
import { getAudioUri } from "@/lib/synthesize";
import { sanitizeTextForSSML } from "@/lib/text";
import * as transport from "@/lib/transport";
import { bytesToDataUri } from "@/lib/tts";
import { fetchAllVoices } from "@/lib/voices";
import { getProvider } from "@/providers";
import type { ProviderId } from "@/providers/types";

// ---------------------------------------------------------------------------
// Voice preview — short locale-appropriate sample on the offscreen preview
// channel (never interrupts an active read). Cached per voice+model.
// ---------------------------------------------------------------------------

const PREVIEW_SAMPLES: Record<string, string> = {
  en: "Hello! This is how I sound.",
  de: "Hallo! So klinge ich.",
  fr: "Bonjour ! Voici ma voix.",
  es: "¡Hola! Así sueno.",
  it: "Ciao! Ecco la mia voce.",
  pt: "Olá! É assim que eu soo.",
  hi: "नमस्ते! मेरी आवाज़ ऐसी है।",
  zh: "你好！这是我的声音。",
  ja: "こんにちは！これが私の声です。",
  ko: "안녕하세요! 제 목소리예요.",
};

const previewCache = new Map<string, string>();
// Bumped on every preview request/stop: a synthesis that finishes for a
// superseded generation must not start playing over the newer one.
let previewGeneration = 0;

async function previewVoice(payload: {
  providerId: ProviderId;
  voiceId: string;
  model: string;
  language?: string;
}): Promise<boolean> {
  const generation = ++previewGeneration;
  const settings = await getSettings();
  const provider = getProvider(payload.providerId);
  const credentials = settings.credentials[payload.providerId] ?? {};

  const langPrefix = (payload.language ?? "en").split("-")[0] ?? "en";
  const sample = PREVIEW_SAMPLES[langPrefix] ?? PREVIEW_SAMPLES.en ?? "Hello!";
  // Same family of format the read-aloud path uses — a preview must prove the
  // voice works the way playback will actually use it.
  const encoding =
    provider.audioFormats.find((f) => f.forReadAloud)?.id ?? provider.audioFormats[0]?.id ?? "MP3";

  // Cached audio is only trustworthy for the exact credentials that produced
  // it — a key change must never replay (or vouch for) stale audio.
  const cacheKey = JSON.stringify([
    payload.providerId,
    payload.voiceId,
    payload.model,
    langPrefix,
    encoding,
    credentials,
  ]);
  let audioUri = previewCache.get(cacheKey);
  if (!audioUri) {
    let result: Awaited<ReturnType<typeof provider.synthesize>>;
    try {
      result = await provider.synthesize({
        text: sample,
        voiceId: payload.voiceId,
        model: payload.model,
        language: payload.language,
        encoding,
        speed: 1,
        pitch: 0,
        volumeGainDb: 0,
        credentials,
      });
    } catch (error) {
      // Only a SYNTHESIS failure says anything about the voice — a local
      // playback hiccup later must not mark it unavailable. Gated on the
      // generation so a superseded preview can't write stale issue state.
      if (generation === previewGeneration) {
        await recordVoiceIssue(
          voiceIssueKey(payload.providerId, payload.voiceId, payload.model),
          String(error),
        ).catch(() => {});
      }
      throw error;
    }
    audioUri = bytesToDataUri(result.bytes, result.extension);
    if (previewCache.size >= 40) previewCache.clear();
    previewCache.set(cacheKey, audioUri);
    // A REAL synthesis success is valid information about the voice even if
    // this preview was superseded meanwhile — clear its issue unconditionally
    // (only stale FAILURE writes are generation-gated above). Cached replays
    // deliberately never clear: they say nothing about current entitlements.
    await clearVoiceIssue(voiceIssueKey(payload.providerId, payload.voiceId, payload.model)).catch(
      () => {},
    );
  }

  // Superseded while synthesizing (another preview or a stop) — stay silent.
  // Rechecked after EVERY remaining await: a stop landing during the issue
  // write or document creation must win; this preview must never play late.
  if (generation !== previewGeneration) return false;

  await ensureOffscreenDocument();
  if (generation !== previewGeneration) return false;
  await sendToOffscreen("previewPlay", { audioUri });
  return true;
}

// ---------------------------------------------------------------------------
// Provider validation — "Save & test": validates DRAFT credentials first and
// persists them only when they work, so a bad paste never destroys a working
// setup. Updates only that provider's flag and voices.
// ---------------------------------------------------------------------------

// Concurrent validations of the SAME provider with different drafts: only the
// newest request may persist its credentials (mirrors previewGeneration).
const validationGenerations = new Map<ProviderId, number>();

async function validateProvider(payload: {
  providerId: ProviderId;
  credentials?: Record<string, string>;
}): Promise<boolean> {
  const generation = (validationGenerations.get(payload.providerId) ?? 0) + 1;
  validationGenerations.set(payload.providerId, generation);

  const settings = await getSettings();
  const provider = getProvider(payload.providerId);
  const candidate = payload.credentials ?? settings.credentials[payload.providerId] ?? {};

  const valid = await provider.validateCredentials(candidate);
  if (!valid) return false;

  // The credential check passed, but the definitive proof is a FRESH voice
  // fetch with these exact credentials — the merged session cache can carry
  // last-good voices from an earlier key and mask a dead one.
  let freshVoices: Awaited<ReturnType<typeof provider.fetchVoices>>;
  try {
    freshVoices = await provider.fetchVoices(candidate);
  } catch {
    freshVoices = [];
  }
  if (freshVoices.length === 0) return false;

  // Superseded by a newer Save & test while validating — this draft must not
  // overwrite the newer one's persisted credentials.
  if (validationGenerations.get(payload.providerId) !== generation) return false;

  // Recompute the nested maps from FRESH state inside the write lock — the
  // pre-validation snapshot may be stale after the network round-trip.
  await updateSettingsWith((current) => ({
    credentials: { ...current.credentials, [payload.providerId]: candidate },
    credentialsValid: { ...current.credentialsValid, [payload.providerId]: true },
    enabledProviders: { ...current.enabledProviders, [payload.providerId]: true },
  }));

  // Inject the verified fresh list so a transient refetch failure can never
  // report success while leaving this provider voiceless in the cache.
  await fetchAllVoices({ providerId: payload.providerId, voices: freshVoices });
  return true;
}

// ---------------------------------------------------------------------------
// Download + selection helpers
// ---------------------------------------------------------------------------

// The popup's request timeout only rejects ITS promise — the work keeps
// running here. A retry must re-attach to the running operation instead of
// firing a second synthesis / a second validation.
const inFlightDownloads = new Map<string, Promise<boolean>>();
const inFlightValidations = new Map<string, Promise<boolean>>();

function deduped<T extends boolean>(
  registry: Map<string, Promise<T>>,
  key: string,
  run: () => Promise<T>,
): Promise<T> {
  const existing = registry.get(key);
  if (existing) return existing;
  const promise = run().finally(() => registry.delete(key));
  registry.set(key, promise);
  return promise;
}

/** bytesToDataUri embeds the format ACTUALLY produced (chunked synthesis may
 *  fall back to a stitchable format) — name the file after the real bytes. */
function downloadExtension(audioUri: string, settings: Settings): string {
  const match = /^data:audio\/([a-z0-9]+);/i.exec(audioUri);
  if (match?.[1]) return match[1];
  const provider = settings.selectedVoice ? getProvider(settings.selectedVoice.providerId) : null;
  return provider?.audioFormats.find((f) => f.id === settings.downloadEncoding)?.extension ?? "mp3";
}

async function download(
  payload: { text: string },
  snapshot?: { settings: Settings; speed: number },
): Promise<boolean> {
  const settings = snapshot?.settings ?? (await getSettings());
  // The file must sound like playback: the mini-player rate multiplies the
  // synthesized speed live, so bake both into the download — getAudioUri
  // clamps to the provider's range, since a file has no playbackRate knob.
  const speed = snapshot?.speed ?? settings.speed * transport.getPlayerState().rate;
  try {
    const audioUri = await getAudioUri({
      text: sanitizeTextForSSML(payload.text),
      encoding: settings.downloadEncoding,
      speed,
      settings,
    });
    const extension = downloadExtension(audioUri, settings);
    await browser.downloads.download({ url: audioUri, filename: `tts-download.${extension}` });
    return true;
  } catch (error) {
    await surfaceError(error);
    return false;
  }
}

async function retrieveSelection(): Promise<string> {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return "";
    const result = await browser.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection()?.toString() ?? "",
    });
    return result[0]?.result ?? "";
  } catch {
    // Privileged page (chrome://, Web Store) — no injection allowed there.
    return "";
  }
}

async function readAloud(payload: { text: string; speed?: number }): Promise<boolean> {
  try {
    // Raw text on purpose: the transport sanitizes at the synthesis boundary
    // and keeps the raw text as the read's identity for the popup.
    return await transport.startReading(payload.text, payload.speed);
  } catch (error) {
    await surfaceError(error);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Context menus
// ---------------------------------------------------------------------------

function createContextMenus(): void {
  browser.contextMenus.removeAll(() => {
    browser.contextMenus.create({
      id: "readAloud",
      title: i18n.t("context_menu.read_aloud"),
      contexts: ["selection"],
    });
    browser.contextMenus.create({
      id: "readAloud1_5x",
      title: i18n.t("context_menu.read_aloud_1_5x"),
      contexts: ["selection"],
    });
    browser.contextMenus.create({
      id: "readAloud2x",
      title: i18n.t("context_menu.read_aloud_2x"),
      contexts: ["selection"],
    });
    browser.contextMenus.create({
      id: "download",
      title: i18n.t("context_menu.download"),
      contexts: ["selection"],
    });
    browser.contextMenus.create({
      id: "stopReading",
      title: i18n.t("context_menu.stop_reading"),
      contexts: ["all"],
    });
  });
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export default defineBackground(() => {
  const bootstrapped = (async () => {
    await migrateLegacySettings();
    createContextMenus();
    await fetchAllVoices().catch((e) => console.warn("Initial voice fetch failed", e));
  })();

  const handlers: Record<string, (payload: unknown) => Promise<unknown>> = {
    fetchVoices: async () => (await fetchAllVoices()).length,
    scanVoices: (p) => scanVoiceAvailability((p as { providerId: string }).providerId),
    validateProvider: (p) => {
      const payload = p as { providerId: ProviderId; credentials?: Record<string, string> };
      // Canonicalize: the same credentials must dedupe regardless of the
      // object's property insertion order.
      const canonical = payload.credentials
        ? Object.fromEntries(
            Object.entries(payload.credentials).sort(([a], [b]) => a.localeCompare(b)),
          )
        : null;
      return deduped(inFlightValidations, JSON.stringify([payload.providerId, canonical]), () =>
        validateProvider(payload),
      );
    },
    readAloud: (p) => readAloud(p as { text: string; speed?: number }),
    stopReading: () => transport.stopReading(),
    download: async (p) => {
      const payload = p as { text: string };
      // The dedupe key must cover everything that shapes the produced file —
      // same text with a different voice/speed/format is a DIFFERENT job.
      // The snapshot is passed through so key and execution cannot diverge.
      const settings = await getSettings();
      const speed = settings.speed * transport.getPlayerState().rate;
      const key = JSON.stringify([
        payload.text,
        settings.selectedVoice,
        settings.model,
        settings.style ?? null,
        settings.downloadEncoding,
        speed,
        settings.pitch,
        settings.volumeGainDb,
      ]);
      return deduped(inFlightDownloads, key, () => download(payload, { settings, speed }));
    },
    previewVoice: (p) => {
      const payload = p as {
        providerId: ProviderId;
        voiceId: string;
        model: string;
        language?: string;
      };
      // previewVoice records/clears voice issues at the SYNTHESIS boundary
      // itself (a local playback failure must not mark a voice unavailable) —
      // here we only make sure the failure reaches the popup banner.
      return previewVoice(payload).catch(async (error) => {
        await surfaceError(error);
        return false;
      });
    },
    stopPreview: async () => {
      previewGeneration++;
      await ensureOffscreenDocument();
      await sendToOffscreen("previewStop");
      return true;
    },
    // Offscreen pings this while audio plays so the service worker (and the
    // in-memory transport state) survives the whole read.
    keepalive: async () => true,
    // Offscreen's throttled timeupdate — mirrored into transport state so
    // playerGetState can restore the timeline when the popup reopens.
    playerProgress: async (p) => {
      transport.updateProgress(p as { currentTime: number; duration: number });
      return true;
    },
    playerPause: () => transport.pause(),
    playerResume: () => transport.resume(),
    playerSeekBy: (p) => transport.seekBy((p as { seconds: number }).seconds),
    playerSeekTo: (p) => transport.seekTo((p as { seconds: number }).seconds),
    playbackEnded: async () => transport.notifyEnded(),
    playerSetRate: (p) => transport.setRate((p as { rate: number }).rate),
    playerGetState: () => transport.getRestoredPlayerState(),
  };

  // Routine/heartbeat routes whose failures must not spam the error banner.
  const quietRoutes = new Set(["fetchVoices", "keepalive", "playerProgress", "playerGetState"]);

  browser.runtime.onMessage.addListener((message: RuntimeMessage, _sender, sendResponse) => {
    if (!message?.id || message.offscreen) return;
    const handler = handlers[message.id];
    if (!handler) return;

    bootstrapped
      .then(() => handler(message.payload))
      .then(sendResponse, async (error) => {
        // A rejected handler must never fail silently: log it, show it, and
        // settle the response so the caller's await resolves.
        console.error(`Handler ${message.id} failed`, error);
        if (!quietRoutes.has(message.id)) await surfaceError(error).catch(() => {});
        sendResponse(undefined);
      });
    return true;
  });

  browser.contextMenus.onClicked.addListener(async (info) => {
    await bootstrapped;
    // Raw text: transport/download sanitize at the synthesis boundary, and
    // the raw text is the read's identity (digest) for the popup.
    const text = (info.selectionText ?? "").trim();
    switch (info.menuItemId) {
      case "readAloud":
        await readAloud({ text });
        break;
      case "readAloud1_5x":
        await readAloud({ text, speed: 1.5 });
        break;
      case "readAloud2x":
        await readAloud({ text, speed: 2 });
        break;
      case "download":
        await download({ text });
        break;
      case "stopReading":
        await transport.stopReading();
        break;
    }
  });

  browser.commands.onCommand.addListener(async (command) => {
    await bootstrapped;
    const text = (await retrieveSelection()).trim();
    if (command === "readAloudShortcut") {
      const state = transport.getPlayerState();
      if (state.status !== "idle") {
        await transport.stopReading();
        if (!text) return; // shortcut doubled as "stop" — done
      }
      if (!text) {
        await surfaceError(new Error(i18n.t("errors.no_selection")));
        return;
      }
      await readAloud({ text });
    } else if (command === "downloadShortcut") {
      if (!text) {
        await surfaceError(new Error(i18n.t("errors.no_selection")));
        return;
      }
      await download({ text });
    }
  });

  browser.runtime.onInstalled.addListener(() => {
    void bootstrapped;
  });
});
