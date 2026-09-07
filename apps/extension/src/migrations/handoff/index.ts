import { chromeListing, LEGACY_IDS } from "@cloud-speech/constants";
import { browser } from "#imports";
import { type Settings, salvageSettings, updateSettingsWith } from "@/lib/storage";
import type { ProviderId } from "@/providers/types";
import { SettingsNewerError } from "../index";
import { createExternalMessageHandler } from "./external";
import { isLegacyInstall } from "./listing";
import { configuredProviders, mergeSnapshot } from "./merge";
import { type HandoffImportRecord, handoffImportsItem, recordHandoffImport } from "./state";

// ---------------------------------------------------------------------------
// Fork-listing settings handoff (Chrome only). The SAME build runs under the
// unified and the fork listing IDs, so both sides of the exchange live here
// and pick their role from browser.runtime.id:
//  - fork side: answers exportSettings requests from the unified install
//    (and records when the unified install confirms an import, so the popup
//    banner can tell the user they're done).
//  - unified side: on every start, pulls settings from each fork install it
//    has not imported yet, and tells each imported fork so until that fork
//    acknowledges; the user gets their credentials and preferences without
//    retyping anything, and a second fork installed later still contributes
//    its provider.
// Everything stays dormant until chromeListing is published.
// ---------------------------------------------------------------------------

/** Fork side: register the external-message listener. Called once from the
 *  background entrypoint; a no-op on Firefox and non-fork installs. */
export function registerHandoff(): void {
  if (import.meta.env.FIREFOX) return;
  if (chromeListing.status !== "published" || !isLegacyInstall()) return;
  browser.runtime.onMessageExternal.addListener(createExternalMessageHandler(chromeListing.id));
}

/** Null when there is nothing to take from that fork right now: it is not
 *  installed, has nothing configured, or runs a NEWER build whose blob this
 *  one cannot decode. All three are retried on the next start. */
async function fetchHandoffSnapshot(forkId: string): Promise<Settings | null> {
  let response: unknown;
  try {
    response = await browser.runtime.sendMessage(forkId, { type: "exportSettings" });
  } catch {
    return null;
  }
  const raw = (response as { ok?: boolean; settings?: unknown } | undefined)?.settings;
  if (!raw || typeof raw !== "object") return null;
  let settings: Settings;
  try {
    settings = salvageSettings(raw);
  } catch (error) {
    if (error instanceof SettingsNewerError) return null;
    throw error;
  }
  return configuredProviders(settings).length === 0 ? null : settings;
}

/** Unified-side import, parameterized for tests; see importHandoffOnce for
 *  the production entrypoint. Each fork is imported once, then told so until
 *  it acknowledges; a fork with nothing to take yet is asked again next
 *  start. */
export async function importHandoff(unifiedId: string, forkIds: readonly string[]): Promise<void> {
  if (!unifiedId || browser.runtime.id !== unifiedId) return;
  const imports = await handoffImportsItem.getValue();
  for (const forkId of forkIds) {
    const record = imports[forkId] ?? (await importFork(forkId));
    if (record === null || record.acknowledged) continue;
    await confirmImport(forkId, record);
  }
}

/** The record is written only after the snapshot was merged under the
 *  settings lock. Null, and so unrecorded, when the fork had nothing to take
 *  (see fetchHandoffSnapshot) or this install's blob is newer than this build
 *  can decode; both are retried next start. */
async function importFork(forkId: string): Promise<HandoffImportRecord | null> {
  const snapshot = await fetchHandoffSnapshot(forkId);
  if (snapshot === null) return null;

  // Merged against the settings as they are INSIDE the lock: a save landing
  // during the export round-trip is kept, and its providers are never
  // overwritten by the snapshot's.
  let added: ProviderId[] = [];
  try {
    await updateSettingsWith((current) => {
      const merged = mergeSnapshot(current, snapshot);
      added = merged.added;
      return merged.settings;
    });
  } catch (error) {
    if (error instanceof SettingsNewerError) return null;
    throw error;
  }
  const record: HandoffImportRecord = {
    importedAt: new Date().toISOString(),
    providers: added,
    acknowledged: false,
  };
  await recordHandoffImport(forkId, record);
  return record;
}

/** Flips that fork's banner to "settings transferred", which also retires its
 *  menus and shortcuts. Acknowledged only on an ok answer, which the fork
 *  sends after its write landed. A rejected send (fork gone, or its event
 *  page not answering) or a failed write leaves the record unacknowledged, so
 *  the next start sends again: the same one-message cost per start as asking
 *  an absent fork for its settings. */
async function confirmImport(forkId: string, record: HandoffImportRecord): Promise<void> {
  let response: unknown;
  try {
    response = await browser.runtime.sendMessage(forkId, { type: "settingsImported" });
  } catch {
    return;
  }
  if (isOk(response)) await recordHandoffImport(forkId, { ...record, acknowledged: true });
}

function isOk(response: unknown): boolean {
  return (
    typeof response === "object" && response !== null && "ok" in response && response.ok === true
  );
}

/** Unified side: pull settings from the fork installs not yet imported. Runs
 *  in the background bootstrap BEFORE the first voice fetch, so the fetch and
 *  reconcile operate on the imported credentials. */
export async function importHandoffOnce(): Promise<void> {
  if (import.meta.env.FIREFOX) return;
  if (chromeListing.status !== "published") return;
  await importHandoff(chromeListing.id, LEGACY_IDS);
}
