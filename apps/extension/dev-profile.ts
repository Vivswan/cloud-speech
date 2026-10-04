import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * A Chrome still holding the profile makes the new launch pass its URLs to that instance and exit at
 * once, so a leftover one is closed first. chrome-launcher opens its log files inside the profile before
 * it creates anything there, so the directory must exist.
 */
export async function reclaimChromeProfile(profile: string, logger: Logger): Promise<void> {
  mkdirSync(profile, { recursive: true });
  if (await closeLeftoverBrowser(`user-data-dir=${profile}`, logger)) {
    removeDeveloperModeCopy(resolve(profile, "Default/Preferences"), logger);
  }
}

// True once no process holds the profile. Chrome rewrites Preferences while it runs and on exit, so a
// profile that is still held, or whose state is unknown, is left alone.
async function closeLeftoverBrowser(match: string, logger: Logger): Promise<boolean> {
  const held = (): boolean => {
    const probe = spawnSync("pgrep", ["-f", match], { stdio: "ignore" });
    // pgrep exits 1 for "no match"; anything else is a failed probe, not an absent browser.
    if (probe.status === 0) return true;
    if (probe.status === 1) return false;
    throw new Error(`pgrep failed: ${probe.error?.message ?? `exit ${probe.status}`}`);
  };
  try {
    if (!held()) return true;
    logger.info("Closing the browser left from the previous dev session...");
    try {
      execFileSync("pkill", ["-f", match], { stdio: "ignore" });
    } catch {
      // Nothing matched: it exited between the probe and the kill.
    }
    const deadline = Date.now() + 3000;
    while (held() && Date.now() < deadline) await sleep(100);
    if (!held()) return true;
    logger.warn("A browser still holds the dev profile; its Preferences are left alone.");
  } catch (error) {
    logger.warn("Could not check the dev profile for a leftover browser:", error);
  }
  return false;
}

// chrome://extensions Developer mode is a tracked pref ("Secure Preferences"): the copy Chrome writes
// into the plain Preferences file on exit registers as tampering and resets the toggle on every launch.
function removeDeveloperModeCopy(prefsFile: string, logger: Logger): void {
  try {
    if (!existsSync(prefsFile)) return;
    const prefs = JSON.parse(readFileSync(prefsFile, "utf8"));
    if (!(prefs.extensions?.ui && "developer_mode" in prefs.extensions.ui)) return;
    delete prefs.extensions.ui.developer_mode;
    // Rename, so Chrome never reads a half-written file.
    const staging = `${prefsFile}.cloud-speech`;
    writeFileSync(staging, JSON.stringify(prefs));
    renameSync(staging, prefsFile);
  } catch (error) {
    logger.warn("Could not clean the dev profile's Preferences:", error);
  }
}
