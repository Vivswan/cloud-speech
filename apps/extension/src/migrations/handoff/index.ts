import { chromeListing, LEGACY_IDS } from "@cloud-speech/constants";
import { browser } from "#imports";
import { getSettings, type Settings, salvageSettings, updateSettingsWith } from "@/lib/storage";
import type { ProviderId } from "@/providers/types";
import { SettingsNewerError } from "../index";
import { createExternalMessageHandler } from "./external";
import { isLegacyInstall } from "./listing";
import { handoffImportDoneItem } from "./state";

// ---------------------------------------------------------------------------
// Fork-listing settings handoff (Chrome only). The SAME build runs under the
// unified and the fork listing IDs, so both sides of the exchange live here
// and pick their role from browser.runtime.id:
//  - fork side: answers exportSettings requests from the unified install
//    (and records when the unified install confirms an import, so the popup
//    banner can tell the user they're done).
//  - unified side: on first run, pulls settings from whichever fork installs
//    are present; the user gets their credentials and preferences without
//    retyping anything.
// Everything stays dormant until chromeListing is published.
// ---------------------------------------------------------------------------

/** Fork side: register the external-message listener. Called once from the
 *  background entrypoint; a no-op on Firefox and non-fork installs. */
export function registerHandoff(): void {
  if (import.meta.env.FIREFOX) return;
  if (chromeListing.status !== "published" || !isLegacyInstall()) return;
  browser.runtime.onMessageExternal.addListener(createExternalMessageHandler(chromeListing.id));
}

type Snapshot =
  | { kind: "configured"; settings: Settings }
  /** Not installed, or nothing configured worth importing. */
  | { kind: "absent" }
  /** Runs a NEWER build than this one: its blob cannot be decoded here. */
  | { kind: "newer" };

async function fetchHandoffSnapshot(forkId: string): Promise<Snapshot> {
  let response: unknown;
  try {
    response = await browser.runtime.sendMessage(forkId, { type: "exportSettings" });
  } catch {
    return { kind: "absent" }; // that fork listing isn't installed
  }
  const raw = (response as { ok?: boolean; settings?: unknown } | undefined)?.settings;
  if (!raw || typeof raw !== "object") return { kind: "absent" };
  let settings: Settings;
  try {
    settings = salvageSettings(raw);
  } catch (error) {
    if (error instanceof SettingsNewerError) return { kind: "newer" };
    throw error;
  }
  return Object.keys(settings.credentials).length === 0
    ? { kind: "absent" }
    : { kind: "configured", settings };
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

/** Unified-side import, parameterized for tests; see importHandoffOnce for
 *  the production entrypoint and the once-only semantics. */
export async function importHandoff(unifiedId: string, forkIds: string[]): Promise<boolean> {
  if (!unifiedId || browser.runtime.id !== unifiedId) return false;
  if (await handoffImportDoneItem.getValue()) return false;

  // Never overwrite a configured install: imports are for fresh ones only.
  // Mark done so an install configured by hand is never asked again. (This
  // is only the cheap pre-check; the authoritative one runs inside the write
  // lock below, where a concurrent popup save can't slip past it.)
  const current = await getSettings();
  if (Object.keys(current.credentials).length > 0) {
    await handoffImportDoneItem.setValue(true);
    return false;
  }

  const snapshots: { forkId: string; settings: Settings }[] = [];
  for (const forkId of forkIds) {
    const snapshot = await fetchHandoffSnapshot(forkId);
    // A fork ahead of this build holds settings this build cannot read yet.
    // Importing the others now would mark the handoff done and lose that
    // fork's share for good; defer the whole handoff until this install
    // updates (nothing written, nothing marked).
    if (snapshot.kind === "newer") return false;
    if (snapshot.kind === "configured") snapshots.push({ forkId, settings: snapshot.settings });
  }
  // Nothing found: deliberately NOT marked done, since the user may install
  // the unified listing first and add a fork's settings later; the next
  // background start retries at the cost of two failed pings.
  if (snapshots.length === 0) return false;

  // Re-check inside the write lock: a save landing during the export
  // round-trip must win over the import.
  let imported = false;
  await updateSettingsWith((fresh) => {
    if (Object.keys(fresh.credentials).length > 0) return {};
    imported = true;
    return mergeSnapshots(snapshots.map((snapshot) => snapshot.settings));
  });
  await handoffImportDoneItem.setValue(true);
  if (!imported) return false;

  // Flip the banner to "settings transferred", but ONLY on the installs
  // whose snapshot was actually taken.
  for (const { forkId } of snapshots) {
    browser.runtime.sendMessage(forkId, { type: "settingsImported" }).catch(() => {});
  }
  return true;
}

/** Unified side: pull settings from the fork installs exactly once. Runs in
 *  the background bootstrap BEFORE the first voice fetch, so the fetch and
 *  reconcile operate on the imported credentials. */
export async function importHandoffOnce(): Promise<boolean> {
  if (import.meta.env.FIREFOX) return false;
  if (chromeListing.status !== "published") return false;
  return importHandoff(chromeListing.id, LEGACY_IDS);
}
