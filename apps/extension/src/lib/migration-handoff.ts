import { browser } from "#imports";
import type { ProviderId } from "@/providers/types";
import { isLegacyInstall, LEGACY_IDS, UNIFIED_ID } from "./listing";
import {
  getSettings,
  legacyImportDoneItem,
  type Settings,
  SettingsSchema,
  updateMigrationBanner,
  updateSettingsWith,
} from "./storage";

// ---------------------------------------------------------------------------
// Legacy-listing settings handoff (Chrome only). The SAME build runs under
// the unified and the legacy listing IDs, so both sides of the exchange live
// here and pick their role from browser.runtime.id:
//  - legacy side: answers exportSettings requests from the unified install
//    (and records when the unified install confirms an import, so the popup
//    banner can tell the user they're done).
//  - unified side: on first run, pulls settings from whichever legacy
//    installs are present; the user gets their credentials and preferences
//    without retyping anything.
// Everything stays dormant until UNIFIED_ID is filled in (lib/listing.ts).
// ---------------------------------------------------------------------------

interface HandoffMessage {
  type?: string;
}

type ExternalSender = { id?: string };
type SendResponse = (response: unknown) => void;

/** Legacy-side message handler, parameterized for tests. Returns true when a
 *  response will arrive asynchronously (runtime.onMessageExternal contract). */
export function createExternalMessageHandler(unifiedId: string) {
  return (
    message: HandoffMessage,
    sender: ExternalSender,
    sendResponse: SendResponse,
  ): true | undefined => {
    // The settings include provider credentials: answer ONLY the unified
    // listing, never any other extension. sender.id is authenticated by the
    // browser; message contents can't spoof it.
    if (!unifiedId || sender.id !== unifiedId) return;

    if (message?.type === "exportSettings") {
      getSettings().then(
        (settings) => sendResponse({ ok: true, settings }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }

    if (message?.type === "settingsImported") {
      // dismissedAt resets so a banner snoozed BEFORE the import still shows
      // its one "settings transferred" confirmation. Respond only after the
      // write lands; the ack must not outrun persistence on an event page.
      // Locked (updateMigrationBanner) so a concurrent popup dismissal can't
      // interleave with this read-modify-write.
      updateMigrationBanner({ imported: true, dismissedAt: null }).then(
        () => sendResponse({ ok: true }),
        () => sendResponse({ ok: false }),
      );
      return true;
    }
  };
}

/** Legacy side: register the external-message listener. Called once from the
 *  background entrypoint; a no-op on Firefox and non-legacy installs. */
export function registerLegacyExport(): void {
  if (import.meta.env.FIREFOX) return;
  if (!UNIFIED_ID || !isLegacyInstall()) return;
  browser.runtime.onMessageExternal.addListener(createExternalMessageHandler(UNIFIED_ID));
}

/** Ask one legacy install for its settings; null when it isn't installed or
 *  has nothing configured worth importing. */
async function fetchLegacySnapshot(legacyId: string): Promise<Settings | null> {
  let response: unknown;
  try {
    response = await browser.runtime.sendMessage(legacyId, { type: "exportSettings" });
  } catch {
    return null; // that legacy listing isn't installed
  }
  const settings = (response as { ok?: boolean; settings?: unknown } | undefined)?.settings;
  const parsed = SettingsSchema.safeParse(settings);
  if (!parsed.success || Object.keys(parsed.data.credentials).length === 0) return null;
  return parsed.data;
}

/** The first configured snapshot is the base (voice selection, prosody, UI
 *  preferences); later ones contribute the providers and favorites the base
 *  doesn't cover; a user who configured Polly in one fork and Azure in the
 *  other keeps both. */
function mergeSnapshots(snapshots: Settings[]): Settings {
  const [base, ...rest] = snapshots as [Settings, ...Settings[]];
  const merged: Settings = { ...base };
  for (const extra of rest) {
    for (const id of Object.keys(extra.credentials) as ProviderId[]) {
      if (merged.credentials[id]) continue;
      merged.credentials = { ...merged.credentials, [id]: extra.credentials[id] ?? {} };
      merged.credentialsValid = {
        ...merged.credentialsValid,
        [id]: extra.credentialsValid[id] ?? false,
      };
      merged.enabledProviders = {
        ...merged.enabledProviders,
        [id]: extra.enabledProviders[id] ?? false,
      };
    }
    merged.favorites = [...new Set([...merged.favorites, ...extra.favorites])];
  }
  return merged;
}

/** Unified-side import, parameterized for tests; see importLegacySettingsOnce
 *  for the production entrypoint and the once-only semantics. */
export async function importLegacySettings(
  unifiedId: string,
  legacyIds: string[],
): Promise<boolean> {
  if (!unifiedId || browser.runtime.id !== unifiedId) return false;
  if (await legacyImportDoneItem.getValue()) return false;

  // Never overwrite a configured install: imports are for fresh ones only.
  // Mark done so an install configured by hand is never asked again. (This
  // is only the cheap pre-check; the authoritative one runs inside the write
  // lock below, where a concurrent popup save can't slip past it.)
  const current = await getSettings();
  if (Object.keys(current.credentials).length > 0) {
    await legacyImportDoneItem.setValue(true);
    return false;
  }

  const snapshots: { legacyId: string; settings: Settings }[] = [];
  for (const legacyId of legacyIds) {
    const settings = await fetchLegacySnapshot(legacyId);
    if (settings) snapshots.push({ legacyId, settings });
  }
  // Nothing found: deliberately NOT marked done, since the user may install
  // the unified listing first and add a legacy fork's settings later; the
  // next background start retries at the cost of two failed pings.
  if (snapshots.length === 0) return false;

  // Re-check inside the write lock: a save landing during the export
  // round-trip must win over the import.
  let imported = false;
  await updateSettingsWith((fresh) => {
    if (Object.keys(fresh.credentials).length > 0) return {};
    imported = true;
    return mergeSnapshots(snapshots.map((snapshot) => snapshot.settings));
  });
  await legacyImportDoneItem.setValue(true);
  if (!imported) return false;

  // Flip the banner to "settings transferred", but ONLY on the installs
  // whose snapshot was actually taken.
  for (const { legacyId } of snapshots) {
    browser.runtime.sendMessage(legacyId, { type: "settingsImported" }).catch(() => {});
  }
  return true;
}

/** Unified side: pull settings from the legacy installs exactly once. Runs
 *  in the background bootstrap BEFORE the first voice fetch, so the fetch and
 *  reconcile operate on the imported credentials. */
export async function importLegacySettingsOnce(): Promise<boolean> {
  if (import.meta.env.FIREFOX) return false;
  return importLegacySettings(UNIFIED_ID, LEGACY_IDS);
}
