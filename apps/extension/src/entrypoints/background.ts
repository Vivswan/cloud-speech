import pMemoize from "p-memoize";
import { browser } from "#imports";
import { ensureAudioHost, recordAudioEvent, sendToAudioHost } from "@/lib/audio/audio-host";
import { previewItem, readPlayback, sameVoiceModelRef } from "@/lib/audio/playback";
import { getAudioUri } from "@/lib/audio/synthesize";
import { bytesToDataUri } from "@/lib/audio/tts";
import {
  describeFailureWithoutCredentials,
  type FailureOperation,
  surfaceError,
} from "@/lib/errors/errors";
import { logWarning } from "@/lib/errors/log";
import { UserFacingError } from "@/lib/errors/user-facing-error";
import {
  backgroundRoutes,
  createDispatcher,
  type Handlers,
  type RouteId,
} from "@/lib/messaging/protocol";
import {
  type ProviderValidationResult,
  validateProviderCandidate,
} from "@/lib/messaging/provider-validation";
import { isAbortError, NEVER_ABORTS, Slot, SlotMap } from "@/lib/messaging/slot";
import * as transport from "@/lib/messaging/transport";
import { trimValues } from "@/lib/settings/credential-checks";
import { scanVoiceAvailability } from "@/lib/settings/probe";
import {
  credentialsFor,
  selectionEncoding,
  withProviderPrefs,
} from "@/lib/settings/provider-state";
import {
  clearVoiceIssue,
  getSettings,
  recordVoiceIssue,
  type Settings,
  updateSettingsWith,
  type VoiceModelRef,
} from "@/lib/settings/storage";
import { fetchAllVoices } from "@/lib/settings/voices";
import { canonicalCredentials, credentialsDigest } from "@/lib/text/digest";
import { i18n, initI18n, type MessageKey, subscribeLocale } from "@/lib/text/i18n-runtime";
import { readActiveTabSelection } from "@/lib/text/page-selection";
import { sanitizeTextForSSML } from "@/lib/text/text";
import { hasCommands, hasContextMenus } from "@/lib/ui/platform";
import { runStartupMigrations } from "@/migrations";
import { getProvider } from "@/providers";
import type { ProviderId } from "@/providers/types";

// ---------------------------------------------------------------------------
// Voice preview. Plays on the preview channel, so it never interrupts a read.
// ---------------------------------------------------------------------------

// `en` is the fallback for a language with no sample, so it is typed as present.
const PREVIEW_SAMPLES: { en: string; [language: string]: string } = {
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

// Sample audio by voice, engine, language, encoding, and credentials; a repeat audition costs no provider call.
const previewCache = new Map<string, string>();

// A newer preview or a stop aborts the in-flight synthesis.
const previewSlot = new Slot();

// The row `previewItem` publishes lands asynchronously, so previewVoice's toggle compares against this copy.
let auditioning: VoiceModelRef | null = null;

function claimPreview(row: VoiceModelRef): AbortSignal {
  auditioning = row;
  return previewSlot.claim().signal;
}

function releasePreview(): void {
  auditioning = null;
  previewSlot.release();
}

/** Housekeeping, never news: the preview itself is reported on its own path, and a stop must still
 *  reach the audio host. A row a refused clear leaves published clears on the next preview or stop. */
function clearPreviewRow(): Promise<void> {
  return previewItem
    .setValue(null)
    .catch((error) => logWarning("Clearing the preview row failed", error));
}

async function stopPreview(): Promise<void> {
  releasePreview();
  // Before the fallible host round-trip: the popup row must clear even if the audio host is gone.
  await clearPreviewRow();
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
  try {
    await previewItem.setValue(row);
    return await runPreview(signal, payload);
  } catch (error) {
    // Superseded or stopped, whether the failure is the cancellation itself or a write that
    // rejected after the stop landed: silence, not a failure.
    if (isAbortError(error) || signal.aborted) return false;
    throw error;
  } finally {
    // previewPlay settles when the audition ends (natural end, play failure, stop, supersede),
    // so the row clears here. A superseded preview must not clear the newer one's row.
    if (!signal.aborted) {
      releasePreview();
      await clearPreviewRow();
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
  const sample = PREVIEW_SAMPLES[langPrefix] ?? PREVIEW_SAMPLES.en;
  // The provider's first read-aloud format, not the saved preference (resolveEncoding in
  // lib/settings/provider-state): a preview proves the voice, and playback may use another read-aloud format.
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
  const claim = validationSlots.claim(payload.providerId);
  const { signal } = claim;

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
        // The write carries this validation's claim: a draft superseded before its turn in the write
        // queue writes nothing. One superseded after its write has landed stays stored until a later validation writes.
        try {
          await updateSettingsWith(claim, (current) =>
            // From `current`, not the pre-validation snapshot: it may be stale after the network round-trip.
            withProviderPrefs(current, payload.providerId, {
              credentials: candidate,
              verified: true,
              enabled: true,
            }),
          );
        } catch (error) {
          if (isAbortError(error)) return "superseded";
          throw error;
        }

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

// The popup's request timeout rejects only its own promise; a retry while the work is still in flight re-attaches.
const downloadOnce = pMemoize(
  (payload: { text: string }, snapshot: { settings: Settings; speed: number }) =>
    download(payload, snapshot),
  {
    // Only the pending promise is kept, so a finished file downloads again on request.
    cache: false,
    // Credentials are left out, so two custom servers with the same selection share one pending download.
    cacheKey: ([payload, { settings, speed }]) =>
      JSON.stringify([
        payload.text,
        settings.selection,
        selectionEncoding(settings, "download"),
        speed,
        settings.pitch,
        settings.volumeGainDb,
      ]),
  },
);

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
// Context menus. Only reached where browser.contextMenus exists (lib/ui/platform);
// Firefox for Android has no such API.
// ---------------------------------------------------------------------------

async function createContextMenus(): Promise<void> {
  // Promise style, not the callback overload: Firefox's native browser.* never invokes a passed callback.
  await browser.contextMenus.removeAll();
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
// titles, so menu changes run on one chain.
let menuChain: Promise<void> = Promise.resolve();
function queueMenuChange(change: () => Promise<void>): Promise<void> {
  menuChain = menuChain.then(change).catch((e) => logWarning("Context menu change failed", e));
  return menuChain;
}
function rebuildContextMenus(): Promise<void> {
  return queueMenuChange(createContextMenus);
}

/** The browser never consumes a listener's promise, so a rejection there is unhandled. The work
 *  inside (a read, a download) reports its own failures to the user; what escapes is the
 *  listener's own refused storage call, and that ends here as a warning. */
function settled<A extends unknown[]>(
  label: string,
  listener: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return (...args) => listener(...args).catch((error) => logWarning(label, error));
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
    // Before the menus so their titles use the chosen language.
    await initI18n();
    if (menusAvailable) {
      // Subscribed before the first rebuild: a locale commit landing in between would otherwise leave stale titles.
      subscribeLocale(() => {
        void rebuildContextMenus();
      });
      await rebuildContextMenus();
    }
    await fetchAllVoices().catch((e) => logWarning("Initial voice fetch failed", e));
    // A fresh context has nothing in flight: a preview a dead context left
    // published would otherwise show as auditioning forever. Both settle, whatever
    // storage does, before the gate opens: every route and listener below waits
    // on this promise, and a late startup clear would erase a row a new preview just published.
    await Promise.all([
      transport.recoverPlayback().catch((e) => logWarning("Recovering playback failed", e)),
      clearPreviewRow(),
    ]);
  })();

  const handlers: Handlers<typeof backgroundRoutes> = {
    fetchVoices: async () => (await fetchAllVoices()).length,
    scanVoices: (payload) => scanVoiceAvailability(payload.providerId),
    validateProvider: (payload) => requestValidation(payload),
    readAloud: (payload) => readAloud(payload),
    stopReading: () => transport.stopReading(),
    download: async (payload) => {
      const settings = await getSettings();
      const speed = settings.speed * (await readPlayback()).rate;
      return downloadOnce(payload, { settings, speed });
    },
    previewVoice: (payload) =>
      previewVoice(payload).catch(async (error) => {
        await surfaceError(error, { providerId: payload.providerId, operation: "preview" });
        return false;
      }),
    // The audio session pings this while audio is loaded so the service worker survives the whole read.
    keepalive: async () => true,
    audioProgress: async (position) => {
      await recordAudioEvent({ kind: "progress", ...position });
      return true;
    },
    audioEnded: async (position) => {
      await recordAudioEvent({ kind: "ended", ...position });
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
    browser.contextMenus.onClicked.addListener(
      settled("Context menu action failed", async (info) => {
        await bootstrapped;
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
      }),
    );
  }

  const noSelection = (titleKey: MessageKey) =>
    new UserFacingError({
      titleKey,
      messageKey: "errors.no_selection",
      detail: "NoSelection: readActiveTabSelection() returned no text",
    });

  if (commandsAvailable) {
    browser.commands.onCommand.addListener(
      settled("Keyboard shortcut failed", async (command) => {
        await bootstrapped;
        const text = await readActiveTabSelection();
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
      }),
    );
  }
});
