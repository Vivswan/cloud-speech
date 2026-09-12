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
// Fork-listing settings handoff (Chrome only): the same build runs under the
// unified and the fork listing ids, so both sides live here and pick their
// role from browser.runtime.id. Dormant until chromeListing is published.
//
//   fork side     -> answers exportSettings; records the unified install's import confirmation for the popup banner
//   unified side  -> on every start pulls settings from each fork not yet imported, then tells that fork until it acknowledges
// ---------------------------------------------------------------------------

/** Fork side. */
export function registerHandoff(): void {
  if (import.meta.env.FIREFOX) return;
  if (chromeListing.status !== "published" || !isLegacyInstall()) return;
  browser.runtime.onMessageExternal.addListener(createExternalMessageHandler(chromeListing.id));
}

/** Null means nothing to take right now; the caller records nothing, so the fork is asked again next start. */
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

/** Unified side, parameterized for tests; importHandoffOnce is the production entrypoint. */
export async function importHandoff(unifiedId: string, forkIds: readonly string[]): Promise<void> {
  if (!unifiedId || browser.runtime.id !== unifiedId) return;
  const imports = await handoffImportsItem.getValue();
  for (const forkId of forkIds) {
    const record = imports[forkId] ?? (await importFork(forkId));
    if (record === null || record.acknowledged) continue;
    await confirmImport(forkId, record);
  }
}

/** The record is written only after the snapshot was merged under the settings lock; an
 *  unrecorded fork is asked again next start. */
async function importFork(forkId: string): Promise<HandoffImportRecord | null> {
  const snapshot = await fetchHandoffSnapshot(forkId);
  if (snapshot === null) return null;

  // Merged against the settings inside the lock, so a save landing during the export round-trip is
  // what mergeSnapshot folds the snapshot into; what it keeps is that function's rule.
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

/** Acknowledged only on an ok answer, which the fork sends after its write landed; a rejected
 *  send or a failed write leaves the record unacknowledged, so the next start sends again. */
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

/** Unified side. */
export async function importHandoffOnce(): Promise<void> {
  if (import.meta.env.FIREFOX) return;
  if (chromeListing.status !== "published") return;
  await importHandoff(chromeListing.id, LEGACY_IDS);
}
