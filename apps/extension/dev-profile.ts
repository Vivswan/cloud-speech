import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

interface Logger {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
}

/**
 * Hands the persistent Chrome dev profile to the launch WXT is about to make (wxt.config.ts calls this
 * from the `server:started` hook).
 *
 * A Chrome still holding the profile makes the new launch pass its URLs to that instance and exit at
 * once, so a leftover one is closed first. chrome-launcher opens its log files inside the profile before
 * it creates anything there, so the directory must exist.
 */
export async function reclaimChromeProfile(profile: string, logger: Logger): Promise<void> {
  mkdirSync(profile, { recursive: true });
  // execFile, no shell: the path must reach pgrep and pkill as ONE argument, never re-parsed by a shell.
  const match = `user-data-dir=${profile}`;
  const browserHolds = (): boolean => {
    const probe = spawnSync("pgrep", ["-f", match], { stdio: "ignore" });
    // pgrep exits 1 for "no match"; anything else is a failed probe, not an absent browser.
    if (probe.status === 0) return true;
    if (probe.status === 1) return false;
    throw new Error(`pgrep failed: ${probe.error?.message ?? `exit ${probe.status}`}`);
  };
  try {
    if (browserHolds()) {
      logger.info("Closing the browser left from the previous dev session...");
      try {
        execFileSync("pkill", ["-f", match], { stdio: "ignore" });
      } catch {
        // Nothing matched: it exited between the probe and the kill.
      }
      const deadline = Date.now() + 3000;
      while (browserHolds() && Date.now() < deadline) await sleep(100);
      if (browserHolds()) {
        logger.warn("A browser still holds the dev profile; the launch may fail.");
      }
    }
  } catch (error) {
    logger.warn("Could not check the dev profile for a leftover browser:", error);
  }

  // chrome://extensions Developer mode is a tracked pref ("Secure Preferences"): a copy of it in the
  // plain Preferences file registers as tampering and resets the toggle on every launch. Chrome writes
  // that copy on exit, hence after the reclaim above.
  try {
    const prefsFile = resolve(profile, "Default/Preferences");
    if (existsSync(prefsFile)) {
      const prefs = JSON.parse(readFileSync(prefsFile, "utf8"));
      if (prefs.extensions?.ui && "developer_mode" in prefs.extensions.ui) {
        delete prefs.extensions.ui.developer_mode;
        writeFileSync(prefsFile, JSON.stringify(prefs));
      }
    }
  } catch (error) {
    logger.warn("Could not clean the dev profile's Preferences:", error);
  }
}
