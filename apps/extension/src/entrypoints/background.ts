import { browser } from "#imports";
import { ensureAudioHost, sendToAudioHost } from "@/lib/audio-host";
import { trimValues } from "@/lib/credential-checks";
import { canonicalCredentials, credentialsDigest } from "@/lib/digest";
import {
  describeFailureWithoutCredentials,
  type FailureOperation,
  surfaceError,
} from "@/lib/errors";
import { i18n, initI18n, type MessageKey, subscribeLocale } from "@/lib/i18n-runtime";
import { hasCommands, hasContextMenus } from "@/lib/platform";
import { applyAudioEvent, previewItem, readPlayback, sameVoiceModelRef } from "@/lib/playback";
import { scanVoiceAvailability } from "@/lib/probe";
import { backgroundRoutes, createDispatcher, type Handlers, type RouteId } from "@/lib/protocol";
import { credentialsFor, selectionEncoding, withProviderPrefs } from "@/lib/provider-state";
import {
  type ProviderValidationResult,
  validateProviderCandidate,
} from "@/lib/provider-validation";
import { isAbortError, NEVER_ABORTS, Slot, SlotMap } from "@/lib/slot";
import {
  clearVoiceIssue,
  getSettings,
  recordVoiceIssue,
  type Settings,
  updateSettingsWith,
  type VoiceModelRef,
} from "@/lib/storage";
import { getAudioUri } from "@/lib/synthesize";
import { sanitizeTextForSSML } from "@/lib/text";
import * as transport from "@/lib/transport";
import { bytesToDataUri } from "@/lib/tts";
import { UserFacingError } from "@/lib/user-facing-error";
import { fetchAllVoices } from "@/lib/voices";
import { runStartupMigrations } from "@/migrations";
import { importHandoffOnce, registerHandoff } from "@/migrations/handoff";
import { initRetiredMode, type RetiredMode } from "@/migrations/handoff/retired";
import { getProvider } from "@/providers";
import type { ProviderId } from "@/providers/types";

// ---------------------------------------------------------------------------
// Voice preview. Plays on the preview channel, so it never interrupts a read.
// ---------------------------------------------------------------------------

const PREVIEW_SAMPLES: Record<string, string> = {
  en: "Hello! This is how I sound.",
  de: "Hallo! So klinge ich.",
  fr: "Bonjour ! Voici ma voix.",
  es: "¡Hola! Así sueno.",
  it: "Ciao! Ecco la mia voce.",
  pt: "Olá! É assim que eu soo.",
  hi: "नमस्ते! मेरी आवाज़ ऐसी है।",
  zh: "你好! 这是我的声音。",
  ja: "こんにちは! これが私の声です。",
  ko: "안녕하세요! 제 목소리예요.",
};

const previewCache = new Map<string, string>();
// A newer preview or a stop aborts the in-flight synthesis. The popup's VoicePicker
// watches the occupant's row through `previewItem` (storage.session); that write lands
// asynchronously, so previewVoice's toggle compares against `auditioning`, the same row in memory.
const previewSlot = new Slot();
let auditioning: VoiceModelRef | null = null;

function claimPreview(row: VoiceModelRef): AbortSignal {
  auditioning = row;
  return previewSlot.claim();
}

function releasePreview(): void {
  auditioning = null;
  previewSlot.release();
}

async function stopPreview(): Promise<void> {
  releasePreview();
  // Before the fallible host round-trip: the popup row must clear even if the audio host is gone.
  await previewItem.setValue(null);
  await ensureAudioHost();
  await sendToAudioHost("previewStop");
}

async function previewVoice(payload: VoiceModelRef & { language?: string }): Promise<boolean> {
  const { providerId, voiceId, model } = payload;
  const row: VoiceModelRef = { providerId, voiceId, model };
  if (auditioning && sameVoiceModelRef(auditioning, row)) {
    await stopPreview();
    return false;
  }
  const signal = claimPreview(row);
  await previewItem.setValue(row);
  try {
    return await runPreview(signal, payload);
  } catch (error) {
    // Superseded or stopped while synthesizing: silence, not a failure.
    if (isAbortError(error)) return false;
    throw error;
  } finally {
    // previewPlay settles when the audition ends (natural end, play failure, stop, supersede),
    // so the row clears here. A superseded preview must not clear the newer one's row.
    if (!signal.aborted) {
      releasePreview();
      await previewItem.setValue(null);
    }
  }
}

async function runPreview(
  signal: AbortSignal,
  payload: VoiceModelRef & { language?: string },
): Promise<boolean> {
  const settings = await getSettings();
  const provider = getProvider(payload.providerId);
  const credentials = credentialsFor(settings, payload.providerId);
  const ref: VoiceModelRef = {
    providerId: payload.providerId,
    voiceId: payload.voiceId,
    model: payload.model,
  };

  const langPrefix = (payload.language ?? "en").split("-")[0] ?? "en";
  const sample = PREVIEW_SAMPLES[langPrefix] ?? PREVIEW_SAMPLES.en ?? "Hello!";
  // The provider's first read-aloud format, not the saved preference (resolveEncoding in
  // lib/provider-state): a preview proves the voice, and playback may use another read-aloud format.
  const encoding =
    provider.audioFormats.find((f) => f.forReadAloud)?.id ?? provider.audioFormats[0].id;

  // Cached audio is only trustworthy for the credentials that produced it; a key change must never replay stale audio.
  const cacheKey = JSON.stringify([
    payload.providerId,
    payload.voiceId,
    payload.model,
    langPrefix,
    encoding,
    await credentialsDigest(credentials),
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
        signal,
      });
    } catch (error) {
      // Only a synthesis failure says anything about the voice; a local playback hiccup later must not
      // mark it unavailable. A superseded preview's failure (its own cancellation included) is no information.
      if (!signal.aborted) {
        const issue = await describeFailureWithoutCredentials(error, {
          providerId: ref.providerId,
          operation: "preview",
        });
        await recordVoiceIssue(ref, issue).catch(() => {});
      }
      throw error;
    }
    audioUri = bytesToDataUri(result.bytes, result.extension);
    if (previewCache.size >= 40) previewCache.clear();
    previewCache.set(cacheKey, audioUri);
    // A synthesis success is information about the voice even when this preview was superseded,
    // so the clear is not gated. Cached replays never clear: they say nothing about current entitlements.
    await clearVoiceIssue(ref).catch(() => {});
  }

  // Rechecked after every remaining await: a stop landing during the issue write or host
  // creation must win, so this preview never plays late.
  signal.throwIfAborted();

  await ensureAudioHost();
  signal.throwIfAborted();
  await sendToAudioHost("previewPlay", { audioUri });
  return true;
}

// ---------------------------------------------------------------------------
// Provider validation (Save & test). Draft credentials persist only once they
// work, so a bad paste never destroys a working setup.
// ---------------------------------------------------------------------------

// Of concurrent validations of one provider, the newest cancels the older's provider call.
const validationSlots = new SlotMap<ProviderId>();

async function validateProvider(payload: {
  providerId: ProviderId;
  credentials?: Record<string, string>;
}): Promise<ProviderValidationResult> {
  const signal = validationSlots.claim(payload.providerId);

  const settings = await getSettings();
  const provider = getProvider(payload.providerId);
  // Trimmed here, not only in the popup: what is validated is what is stored, and a pasted
  // trailing newline in a header value makes fetch throw as a baffling "network" failure.
  const candidate = trimValues(payload.credentials ?? credentialsFor(settings, payload.providerId));

  try {
    return await validateProviderCandidate(
      provider,
      candidate,
      async (freshVoices) => {
        // Checked inside the updater: a draft superseded before its turn in the write queue writes
        // nothing. One superseded after its write has landed stays stored until a later validation writes.
        let persisted = false;
        await updateSettingsWith((current) => {
          if (signal.aborted) return {};
          persisted = true;
          // From `current`, not the pre-validation snapshot: it may be stale after the network round-trip.
          return withProviderPrefs(current, payload.providerId, {
            credentials: candidate,
            verified: true,
            enabled: true,
          });
        });
        if (!persisted) return "superseded";

        // The voices validation just fetched are injected, so the cache needs no second voice request.
        // Best-effort: a voice-cache hiccup must not be reported as "credentials kept" when they were just written.
        await fetchAllVoices({ providerId: payload.providerId, voices: freshVoices }).catch(
          () => {},
        );
        return "persisted";
      },
      signal,
    );
  } finally {
    if (!signal.aborted) validationSlots.release(payload.providerId);
  }
}

// The popup's request timeout only rejects its own promise; the work keeps running here, so a
// retry while it is still in flight re-attaches instead of firing a second validation.
interface InFlightValidation {
  draft: string;
  promise: Promise<ProviderValidationResult>;
}
const inFlightValidations = new Map<ProviderId, InFlightValidation>();

function requestValidation(payload: {
  providerId: ProviderId;
  credentials?: Record<string, string>;
}): Promise<ProviderValidationResult> {
  const draft = payload.credentials ? canonicalCredentials(payload.credentials) : "stored";
  const current = inFlightValidations.get(payload.providerId);
  if (current?.draft === draft) return current.promise;
  // No await before the claim: requests claim in arrival order and the newest wins. The entry is
  // replaced in the same step, so repeating the superseded draft validates anew, and a superseded
  // entry settling late leaves the newer one alone.
  const entry: InFlightValidation = {
    draft,
    promise: validateProvider(payload).finally(() => {
      if (inFlightValidations.get(payload.providerId) === entry) {
        inFlightValidations.delete(payload.providerId);
      }
    }),
  };
  inFlightValidations.set(payload.providerId, entry);
  return entry.promise;
}

// ---------------------------------------------------------------------------
// Download + selection helpers
// ---------------------------------------------------------------------------

// The popup's request timeout only rejects its own promise; the work keeps running here, so a
// retry while it is still in flight re-attaches instead of firing a second synthesis.
const inFlightDownloads = new Map<string, Promise<boolean>>();

function deduped<T>(
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

/** The data URI carries the format actually produced (chunked synthesis may fall back to a
 *  stitchable one), so the file is named after the real bytes, not the setting. */
function downloadExtension(audioUri: string, settings: Settings): string {
  const match = /^data:audio\/([a-z0-9]+);/i.exec(audioUri);
  if (match?.[1]) return match[1];
  const provider = settings.selection ? getProvider(settings.selection.providerId) : null;
  const encoding = selectionEncoding(settings, "download");
  return provider?.audioFormats.find((f) => f.id === encoding)?.extension ?? "mp3";
}

async function download(
  payload: { text: string },
  snapshot?: { settings: Settings; speed: number },
): Promise<boolean> {
  const settings = snapshot?.settings ?? (await getSettings());
  // The mini-player rate multiplies the synthesized speed live, so the file bakes both in;
  // getAudioUri clamps the product to the provider's range.
  const speed = snapshot?.speed ?? settings.speed * (await readPlayback()).rate;
  try {
    const audioUri = await getAudioUri({
      text: sanitizeTextForSSML(payload.text),
      purpose: "download",
      speed,
      settings,
      // Downloads are deduped, never superseded: the file must complete.
      signal: NEVER_ABORTS,
    });
    const extension = downloadExtension(audioUri, settings);
    await browser.downloads.download({ url: audioUri, filename: `tts-download.${extension}` });
    return true;
  } catch (error) {
    // The selection names the provider the request went to; a fetch that
    // never got an answer cannot name it itself.
    await surfaceError(error, {
      operation: "download",
      ...(settings.selection ? { providerId: settings.selection.providerId } : {}),
    });
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
    // Privileged page (chrome://, Web Store); no injection allowed there.
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
// Context menus. Only reached where browser.contextMenus exists (lib/platform);
// Firefox for Android has no such API.
// ---------------------------------------------------------------------------

async function createContextMenus(): Promise<void> {
  // Promise style, not the callback overload: Firefox's native browser.* never invokes a passed callback.
  await browser.contextMenus.removeAll();
  // Retirement can land during that removal; its menus must then stay gone.
  if (retiredMode.isRetired()) return;
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
}

// Concurrent removeAll()+create cycles race on the same ids and could leave an older language's
// titles, so menu changes run on one chain. Retirement clears through the same chain, so a build
// already queued cannot recreate its menus afterwards.
let menuChain: Promise<void> = Promise.resolve();
// Set during the bootstrap; every reader awaits `bootstrapped` first.
let retiredMode: RetiredMode = { isRetired: () => false };
function queueMenuChange(change: () => Promise<void>): Promise<void> {
  menuChain = menuChain.then(change).catch((e) => console.warn("Context menu change failed", e));
  return menuChain;
}
function rebuildContextMenus(): Promise<void> {
  return queueMenuChange(createContextMenus);
}
function clearContextMenus(): Promise<void> {
  return queueMenuChange(() => browser.contextMenus.removeAll());
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

export default defineBackground(() => {
  // Firefox for Android implements neither API; nothing below may touch a namespace its check denied.
  const menusAvailable = hasContextMenus();
  const commandsAvailable = hasCommands();

  const bootstrapped = (async () => {
    await runStartupMigrations();
    // Before the voice fetch, so it runs with the imported credentials.
    await importHandoffOnce().catch((e) => console.warn("Settings handoff import failed", e));
    // A retired install shows no menus, so this is known before the first menu build.
    retiredMode = await initRetiredMode(menusAvailable ? clearContextMenus : async () => {});
    // After the imports so an imported uiLanguage is honored on first run, before the menus
    // so their titles use the chosen language.
    await initI18n();
    if (menusAvailable) {
      // Subscribed before the first rebuild: a locale commit landing in between would otherwise leave stale titles.
      subscribeLocale(() => {
        void rebuildContextMenus();
      });
      await rebuildContextMenus();
    }
    await fetchAllVoices().catch((e) => console.warn("Initial voice fetch failed", e));
    // A fresh context has nothing in flight: a preview a dead context left
    // published would otherwise show as auditioning forever.
    await Promise.all([transport.recoverPlayback(), previewItem.setValue(null)]);
  })();

  registerHandoff();

  const handlers: Handlers<typeof backgroundRoutes> = {
    fetchVoices: async () => (await fetchAllVoices()).length,
    scanVoices: (payload) => scanVoiceAvailability(payload.providerId),
    validateProvider: (payload) => requestValidation(payload),
    readAloud: (payload) => readAloud(payload),
    stopReading: () => transport.stopReading(),
    download: async (payload) => {
      // The key omits credentials, so two custom servers with the same selection share one pending
      // download. The same snapshot is passed through so key and execution cannot diverge.
      const settings = await getSettings();
      const speed = settings.speed * (await readPlayback()).rate;
      const key = JSON.stringify([
        payload.text,
        settings.selection,
        selectionEncoding(settings, "download"),
        speed,
        settings.pitch,
        settings.volumeGainDb,
      ]);
      return deduped(inFlightDownloads, key, () => download(payload, { settings, speed }));
    },
    previewVoice: (payload) =>
      previewVoice(payload).catch(async (error) => {
        await surfaceError(error, { providerId: payload.providerId, operation: "preview" });
        return false;
      }),
    // The audio session pings this while audio is loaded so the service worker survives the whole read.
    keepalive: async () => true,
    audioProgress: async (position) => {
      await applyAudioEvent({ kind: "progress", ...position });
      return true;
    },
    audioEnded: async (position) => {
      await applyAudioEvent({ kind: "ended", ...position });
      return true;
    },
    playerPause: () => transport.pause(),
    playerResume: () => transport.resume(),
    playerSeekTo: (payload) => transport.seekTo(payload.seconds),
    playerSetRate: (payload) => transport.setRate(payload.rate),
  };

  // Routine/heartbeat routes whose failures must not spam the error banner.
  const quietRoutes = new Set<RouteId<"background">>([
    "fetchVoices",
    "keepalive",
    "audioProgress",
    "audioEnded",
  ]);
  // Absent routes read or serve a read, and their notice is titled as one. validateProvider is a
  // check: a Save & test failing before the verdict (its settings read rejected) is titled like the inline one.
  const routeOperations: Partial<Record<RouteId<"background">, FailureOperation>> = {
    download: "download",
    previewVoice: "preview",
    scanVoices: "scan",
    validateProvider: "scan",
  };

  browser.runtime.onMessage.addListener(
    createDispatcher("background", backgroundRoutes, handlers, {
      gate: bootstrapped,
      onError: async (id, error) => {
        if (quietRoutes.has(id)) return;
        const operation = routeOperations[id];
        await surfaceError(error, operation ? { operation } : {}).catch(() => {});
      },
    }),
  );

  if (menusAvailable) {
    browser.contextMenus.onClicked.addListener(async (info) => {
      await bootstrapped;
      if (retiredMode.isRetired()) return;
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
  }

  const noSelection = (titleKey: MessageKey) =>
    new UserFacingError({
      titleKey,
      messageKey: "errors.no_selection",
      detail: "NoSelection: retrieveSelection() returned no text after trim",
    });

  if (commandsAvailable) {
    browser.commands.onCommand.addListener(async (command) => {
      await bootstrapped;
      if (retiredMode.isRetired()) return;
      const text = (await retrieveSelection()).trim();
      if (command === "readAloudShortcut") {
        if ((await readPlayback()).status !== "idle") {
          await transport.stopReading();
          if (!text) return; // shortcut doubled as "stop"; done
        }
        if (!text) {
          await surfaceError(noSelection("errors.read_failed_title"));
          return;
        }
        await readAloud({ text });
      } else if (command === "downloadShortcut") {
        if (!text) {
          await surfaceError(noSelection("errors.download_failed_title"));
          return;
        }
        await download({ text });
      }
    });
  }

  browser.runtime.onInstalled.addListener(() => {
    void bootstrapped;
  });
});
