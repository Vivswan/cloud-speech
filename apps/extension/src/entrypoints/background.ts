import { browser } from "#imports";
import { ensureAudioHost, sendToAudioHost } from "@/lib/audio-host";
import { trimValues } from "@/lib/credential-checks";
import { textDigest } from "@/lib/digest";
import { surfaceError } from "@/lib/errors";
import { i18n, initI18n, subscribeLocale } from "@/lib/i18n-runtime";
import { applyAudioEvent, previewItem, readPlayback } from "@/lib/playback";
import { scanVoiceAvailability } from "@/lib/probe";
import { backgroundRoutes, createDispatcher, type Handlers, type RouteId } from "@/lib/protocol";
import { credentialsFor } from "@/lib/provider-state";
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
  voiceIssueKey,
} from "@/lib/storage";
import { getAudioUri } from "@/lib/synthesize";
import { sanitizeTextForSSML } from "@/lib/text";
import * as transport from "@/lib/transport";
import { bytesToDataUri } from "@/lib/tts";
import { fetchAllVoices } from "@/lib/voices";
import { runStartupMigrations } from "@/migrations";
import { importHandoffOnce, registerHandoff } from "@/migrations/handoff";
import { initRetiredMode, type RetiredMode } from "@/migrations/handoff/retired";
import { getProvider } from "@/providers";
import type { ProviderId } from "@/providers/types";

// ---------------------------------------------------------------------------
// Voice preview: short locale-appropriate sample on the offscreen preview
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
  zh: "你好! 这是我的声音。",
  ja: "こんにちは! これが私の声です。",
  ko: "안녕하세요! 제 목소리예요.",
};

const previewCache = new Map<string, string>();
// Occupied by the preview in flight: a newer preview or a stop aborts its
// synthesis, so it can neither cost more nor start playing over the newer one.
// The occupant's voice row is published as `previewItem` (storage.session),
// which the popup's VoicePicker watches.
const previewSlot = new Slot();

async function previewVoice(payload: {
  providerId: ProviderId;
  voiceId: string;
  model: string;
  language?: string;
}): Promise<boolean> {
  const signal = previewSlot.claim();
  const { providerId, voiceId, model } = payload;
  await previewItem.setValue({ providerId, voiceId, model });
  try {
    return await runPreview(signal, payload);
  } catch (error) {
    // Superseded or stopped while synthesizing: silence, not a failure.
    if (isAbortError(error)) return false;
    throw error;
  } finally {
    // previewPlay settles exactly when the audition ends (natural end, load
    // or play failure, stop, supersede), so this is where the row clears.
    // Ownership-checked: a superseded preview must not clear the newer one.
    if (!signal.aborted) {
      previewSlot.release();
      await previewItem.setValue(null);
    }
  }
}

async function runPreview(
  signal: AbortSignal,
  payload: {
    providerId: ProviderId;
    voiceId: string;
    model: string;
    language?: string;
  },
): Promise<boolean> {
  const settings = await getSettings();
  const provider = getProvider(payload.providerId);
  const credentials = credentialsFor(settings, payload.providerId);

  const langPrefix = (payload.language ?? "en").split("-")[0] ?? "en";
  const sample = PREVIEW_SAMPLES[langPrefix] ?? PREVIEW_SAMPLES.en ?? "Hello!";
  // Same family of format the read-aloud path uses: a preview must prove the
  // voice works the way playback will actually use it.
  const encoding =
    provider.audioFormats.find((f) => f.forReadAloud)?.id ?? provider.audioFormats[0].id;

  // Cached audio is only trustworthy for the exact credentials that produced
  // it; a key change must never replay (or vouch for) stale audio.
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
        signal,
      });
    } catch (error) {
      // Only a SYNTHESIS failure says anything about the voice; a local
      // playback hiccup later must not mark it unavailable. A superseded
      // preview's failure (its own cancellation included) is no information.
      if (!signal.aborted) {
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
    // this preview was superseded meanwhile, so clear its issue unconditionally
    // (only stale FAILURE writes are gated above). Cached replays deliberately
    // never clear: they say nothing about current entitlements.
    await clearVoiceIssue(voiceIssueKey(payload.providerId, payload.voiceId, payload.model)).catch(
      () => {},
    );
  }

  // Superseded while synthesizing (another preview or a stop): stay silent.
  // Rechecked after EVERY remaining await: a stop landing during the issue
  // write or document creation must win; this preview must never play late.
  signal.throwIfAborted();

  await ensureAudioHost();
  signal.throwIfAborted();
  await sendToAudioHost("previewPlay", { audioUri });
  return true;
}

// ---------------------------------------------------------------------------
// Provider validation ("Save & test"): validates DRAFT credentials first and
// persists them only when they work, so a bad paste never destroys a working
// setup. Updates only that provider's flag and voices.
// ---------------------------------------------------------------------------

// Concurrent validations of the SAME provider with different drafts: the
// newest request cancels the older one's provider call and alone may persist.
const validationSlots = new SlotMap<ProviderId>();

async function validateProvider(payload: {
  providerId: ProviderId;
  credentials?: Record<string, string>;
}): Promise<ProviderValidationResult> {
  const signal = validationSlots.claim(payload.providerId);

  const settings = await getSettings();
  const provider = getProvider(payload.providerId);
  // Trim here (not only in the popup): what gets validated is exactly what
  // gets stored, and a pasted trailing newline in a header value makes fetch
  // throw as a baffling "network" failure.
  const candidate = trimValues(payload.credentials ?? credentialsFor(settings, payload.providerId));

  try {
    return await validateProviderCandidate(
      provider,
      candidate,
      async (freshVoices) => {
        // Superseded by a newer Save & test while validating: this draft must
        // not overwrite the newer one's persisted credentials. Checked INSIDE
        // the updater (which runs under the cross-context write lock), so a
        // newer request can't start between the check and the write.
        let persisted = false;
        await updateSettingsWith((current) => {
          if (signal.aborted) return {};
          persisted = true;
          // Recompute the nested maps from FRESH state inside the write lock;
          // the pre-validation snapshot may be stale after the network trip.
          return {
            credentials: { ...current.credentials, [payload.providerId]: candidate },
            credentialsValid: { ...current.credentialsValid, [payload.providerId]: true },
            enabledProviders: { ...current.enabledProviders, [payload.providerId]: true },
          };
        });
        if (!persisted) return "superseded";

        // Inject the verified list directly; validation already made the only
        // provider request needed for this Save & test. Best-effort: a
        // voice-cache hiccup must not be reported as "credentials kept" when
        // they were in fact just written.
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

// ---------------------------------------------------------------------------
// Download + selection helpers
// ---------------------------------------------------------------------------

// The popup's request timeout only rejects ITS promise; the work keeps
// running here. A retry must re-attach to the running operation instead of
// firing a second synthesis / a second validation.
const inFlightDownloads = new Map<string, Promise<boolean>>();
const inFlightValidations = new Map<string, Promise<ProviderValidationResult>>();

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

/** bytesToDataUri embeds the format ACTUALLY produced (chunked synthesis may
 *  fall back to a stitchable format), so name the file after the real bytes. */
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
  // synthesized speed live, so bake both into the download; getAudioUri
  // clamps to the provider's range, since a file has no playbackRate knob.
  const speed = snapshot?.speed ?? settings.speed * (await readPlayback()).rate;
  try {
    const audioUri = await getAudioUri({
      text: sanitizeTextForSSML(payload.text),
      encoding: settings.downloadEncoding,
      speed,
      settings,
      // Downloads are deduped, never superseded: the file must complete.
      signal: NEVER_ABORTS,
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
// Context menus
// ---------------------------------------------------------------------------

async function createContextMenus(): Promise<void> {
  // Promise style, not the callback overload: Firefox's native browser.*
  // namespace is promise-only and never invokes a passed callback.
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

// Menu changes are SERIALIZED: concurrent removeAll()+create cycles race on
// the same ids, and out-of-order completion could leave an older language's
// titles. The chain guarantees the last-queued change runs last, and t()
// reads the locale current at create time, so the newest language wins.
// Retirement removes its menus through the same chain, so no build that is
// already mid-flight can recreate them afterwards.
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
  const bootstrapped = (async () => {
    await runStartupMigrations();
    // Unified-listing installs pull settings from the fork listings' installs
    // BEFORE the voice fetch, so it runs with the imported credentials.
    await importHandoffOnce().catch((e) => console.warn("Settings handoff import failed", e));
    // Fork-listing installs whose settings were taken go quiet (no menus,
    // no-op shortcuts); must be known before the first menu build.
    retiredMode = await initRetiredMode(clearContextMenus);
    // After the imports so an imported uiLanguage is honored on first run,
    // before the menus so their titles use the chosen language.
    await initI18n();
    // Subscribe BEFORE the first rebuild: a locale commit landing in between
    // would otherwise be lost, leaving stale titles. The initial-load
    // notification just queues a redundant rebuild on the serialized chain.
    subscribeLocale(() => {
      void rebuildContextMenus();
    });
    await rebuildContextMenus();
    await fetchAllVoices().catch((e) => console.warn("Initial voice fetch failed", e));
    // A fresh context has nothing in flight: a preview a dead context left
    // published would otherwise show as auditioning forever.
    await Promise.all([transport.recoverPlayback(), previewItem.setValue(null)]);
  })();

  // Fork-listing installs answer the unified install's settings requests.
  registerHandoff();

  const handlers: Handlers<typeof backgroundRoutes> = {
    fetchVoices: async () => (await fetchAllVoices()).length,
    scanVoices: (payload) => scanVoiceAvailability(payload.providerId),
    validateProvider: (payload) => {
      // Canonicalize and fingerprint: the same credentials dedupe regardless
      // of insertion order, without keeping raw candidate secrets as Map keys.
      const canonical = payload.credentials
        ? Object.fromEntries(
            Object.entries(payload.credentials).sort(([a], [b]) => a.localeCompare(b)),
          )
        : null;
      const key = textDigest(JSON.stringify([payload.providerId, canonical]));
      return deduped(inFlightValidations, key, () => validateProvider(payload));
    },
    readAloud: (payload) => readAloud(payload),
    stopReading: () => transport.stopReading(),
    download: async (payload) => {
      // The dedupe key must cover everything that shapes the produced file:
      // same text with a different voice/speed/format is a DIFFERENT job.
      // The snapshot is passed through so key and execution cannot diverge.
      const settings = await getSettings();
      const speed = settings.speed * (await readPlayback()).rate;
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
    previewVoice: (payload) =>
      // previewVoice records/clears voice issues at the SYNTHESIS boundary
      // itself (a local playback failure must not mark a voice unavailable);
      // here we only make sure the failure reaches the popup banner.
      previewVoice(payload).catch(async (error) => {
        await surfaceError(error);
        return false;
      }),
    stopPreview: async () => {
      previewSlot.release();
      // Clear before the (fallible) host round-trip: the popup row must
      // clear even if the audio host is already gone. The in-flight
      // previewVoice's finally sees its aborted signal and leaves the slot
      // alone.
      await previewItem.setValue(null);
      await ensureAudioHost();
      await sendToAudioHost("previewStop");
      return true;
    },
    // The audio session pings this while audio is loaded so the service
    // worker survives the whole read.
    keepalive: async () => true,
    // The session's position events, stamped with the epoch of the play they
    // belong to; the document drops one whose read was stopped or superseded.
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

  browser.runtime.onMessage.addListener(
    createDispatcher("background", backgroundRoutes, handlers, {
      gate: bootstrapped,
      // A rejected handler must never fail silently: the dispatcher logs it
      // and settles the reply; loud routes also reach the user.
      onError: async (id, error) => {
        if (!quietRoutes.has(id)) await surfaceError(error).catch(() => {});
      },
    }),
  );

  browser.contextMenus.onClicked.addListener(async (info) => {
    await bootstrapped;
    if (retiredMode.isRetired()) return;
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
    if (retiredMode.isRetired()) return;
    const text = (await retrieveSelection()).trim();
    if (command === "readAloudShortcut") {
      if ((await readPlayback()).status !== "idle") {
        await transport.stopReading();
        if (!text) return; // shortcut doubled as "stop"; done
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
