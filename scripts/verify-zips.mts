#!/usr/bin/env bun
// Release smoke test: every store zip carries a manifest that matches its store, with the right version,
// the right name, and never the dev `key` (a key in a store upload breaks the listing's identity). Zips
// are found by version+browser suffix so wxt.config.ts stays the only place the filename pattern is
// written down.

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME_LISTING_ID, EXTENSION_NAME } from "@cloud-speech/constants";
import { runCheck } from "./lib/report.mts";

/** The manifest fields the checks below read; everything else in the zip's manifest.json is left alone. */
interface StoreManifest {
  version?: string;
  name?: string;
  key?: string;
  manifest_version?: number;
  default_locale?: string;
  host_permissions?: string[];
  permissions?: string[];
  minimum_chrome_version?: string;
  background?: { scripts?: string[]; service_worker?: string };
  browser_specific_settings?: {
    gecko?: { id?: string; data_collection_permissions?: { required?: string[] } };
  };
}

// Deliberately duplicated from wxt.config.ts as a test oracle: a build that silently drops the gecko ID
// must fail here.
const GECKO_ID = "cloud-speech@vivswan";

// Pinned exactly, not as a floor: the stores reject any permission the extension does not need, so a
// new one must be added here on purpose.
const BASE_PERMISSIONS = ["contextMenus", "downloads", "storage", "scripting"];

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function scanZips(root: string): {
  inspected: number;
  findings: string[];
  verified: string[];
} {
  const { version } = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
    version: string;
  };
  const outDir = resolve(root, "apps/extension/.output");
  // The package is what users install, so it must carry the same terms the store listing shows
  // (wxt.config.ts copies the root file in through build:publicAssets).
  const license = readFileSync(resolve(root, "LICENSE.md"));

  const findings: string[] = [];
  const verified: string[] = [];
  let inspected = 0;

  const check = (holds: boolean, message: string): void => {
    inspected++;
    if (!holds) findings.push(message);
  };

  /** Exactly one: several means a stray copy of this version's zip is in the way. */
  const findZip = (label: string, suffix: string): string | null => {
    const wanted = `-${version}${suffix}`;
    const matches = readdirSync(outDir).filter((name) => name.endsWith(wanted));
    const [match] = matches;
    inspected++;
    if (matches.length === 1 && match !== undefined) return resolve(outDir, match);
    findings.push(
      `${label}: expected exactly one *${wanted} in ${outDir}, found ${matches.length}`,
    );
    return null;
  };

  const readManifest = (label: string, zip: string): StoreManifest | null => {
    inspected++;
    try {
      return JSON.parse(execFileSync("unzip", ["-p", zip, "manifest.json"], { encoding: "utf8" }));
    } catch (error) {
      findings.push(`${label}: could not read manifest.json from zip (${messageOf(error)})`);
      return null;
    }
  };

  const checkLicense = (label: string, zip: string): void => {
    inspected++;
    let shipped: Buffer;
    try {
      shipped = execFileSync("unzip", ["-p", zip, "LICENSE.md"]);
    } catch (error) {
      findings.push(`${label}: LICENSE.md missing from zip (${messageOf(error)})`);
      return;
    }
    if (!shipped.equals(license)) {
      findings.push(`${label}: LICENSE.md in zip differs from the repository's LICENSE.md`);
    }
  };

  const checkCommon = (label: string, manifest: StoreManifest): void => {
    check(
      manifest.version === version,
      `${label}: manifest version ${manifest.version} != package version ${version}`,
    );
    check(
      manifest.name === EXTENSION_NAME,
      `${label}: manifest name "${manifest.name}" != "${EXTENSION_NAME}"`,
    );
    check(
      !manifest.key,
      `${label}: manifest contains the dev "key", which must never ship to the store`,
    );
    check(
      manifest.manifest_version === 3,
      `${label}: manifest_version ${manifest.manifest_version} != 3`,
    );
    check(
      Boolean(manifest.default_locale),
      `${label}: default_locale missing (locales won't load)`,
    );
    check(
      JSON.stringify(manifest.host_permissions) === JSON.stringify(["<all_urls>"]),
      `${label}: host_permissions ${JSON.stringify(manifest.host_permissions)} != ["<all_urls>"]`,
    );
  };

  const checkPermissions = (
    label: string,
    manifest: StoreManifest,
    expected: readonly string[],
  ): void => {
    const declared = (manifest.permissions ?? []).slice().sort();
    check(
      JSON.stringify(declared) === JSON.stringify(expected.slice().sort()),
      `${label}: permissions ${JSON.stringify(manifest.permissions)} != ${JSON.stringify(expected)}`,
    );
  };

  // --- chrome ---
  const chromeZip = findZip("chrome", "-chrome.zip");
  const chromeManifest = chromeZip && readManifest("chrome", chromeZip);
  if (chromeZip && chromeManifest) {
    const before = findings.length;
    checkCommon("chrome", chromeManifest);
    // offscreen: Chrome playback runs in an offscreen document.
    checkPermissions("chrome", chromeManifest, [...BASE_PERMISSIONS, "offscreen"]);
    check(Boolean(chromeManifest.minimum_chrome_version), "chrome: minimum_chrome_version missing");
    checkLicense("chrome", chromeZip);
    if (findings.length === before) {
      verified.push(`chrome ok: ${chromeManifest.name} v${chromeManifest.version}`);
    }
  }

  // --- firefox ---
  const firefoxZip = findZip("firefox", "-firefox.zip");
  const firefoxManifest = firefoxZip && readManifest("firefox", firefoxZip);
  if (firefoxZip && firefoxManifest) {
    const before = findings.length;
    checkCommon("firefox", firefoxManifest);
    const geckoId = firefoxManifest.browser_specific_settings?.gecko?.id;
    check(geckoId === GECKO_ID, `firefox: gecko id "${geckoId}" != "${GECKO_ID}"`);
    check(
      Boolean(firefoxManifest.background?.scripts?.length),
      "firefox: background.scripts missing (event page required)",
    );
    check(
      !firefoxManifest.background?.service_worker,
      "firefox: background.service_worker present; Firefox needs an event page",
    );
    // No offscreen: Firefox has no offscreen API; audio plays in the event page.
    checkPermissions("firefox", firefoxManifest, BASE_PERMISSIONS);
    check(
      !firefoxManifest.minimum_chrome_version,
      "firefox: minimum_chrome_version present (a chrome-only field)",
    );
    checkLicense("firefox", firefoxZip);
    // Required for new AMO submissions since Nov 2025. Pinned as a whole list: WXT types the field as plain
    // strings, so a category dropped or added in wxt.config.ts would pass the type check.
    const declared = firefoxManifest.browser_specific_settings?.gecko?.data_collection_permissions;
    const expectedDataCollection = ["websiteContent", "authenticationInfo"];
    check(
      JSON.stringify(declared?.required?.slice().sort()) ===
        JSON.stringify(expectedDataCollection.slice().sort()),
      `firefox: gecko.data_collection_permissions.required ${JSON.stringify(declared?.required)} ` +
        `!= ${JSON.stringify(expectedDataCollection)}`,
    );
    const sourcesZip = findZip("firefox sources", "-firefox-sources.zip");
    if (sourcesZip) {
      // README's rebuild steps send AMO reviewers to .bun-version; WXT's source glob skips dotfiles unless
      // wxt.config.ts includes it explicitly.
      inspected++;
      try {
        const entries = execFileSync("unzip", ["-Z1", sourcesZip], { encoding: "utf8" }).split(
          "\n",
        );
        if (!entries.includes(".bun-version")) {
          findings.push(
            "firefox sources: .bun-version missing (the README rebuild steps point at it)",
          );
        }
      } catch (error) {
        findings.push(`firefox sources: could not list the zip (${messageOf(error)})`);
      }
    }
    if (findings.length === before) {
      verified.push(`firefox ok: ${firefoxManifest.name} v${firefoxManifest.version}`);
    }
  }

  // --- README badge (manual copy of the install-listing ID) ---
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  const badgeIds = [
    ...readme.matchAll(/(?:chrome-web-store\/v|chromewebstore\.google\.com\/detail)\/([a-p]{32})/g),
  ].map((match) => match[1]);
  check(badgeIds.length > 0, "README: no Chrome Web Store badge/link found");
  for (const id of badgeIds) {
    check(
      id === CHROME_LISTING_ID,
      `README: store badge/link ID ${id} != expected install listing ${CHROME_LISTING_ID}`,
    );
  }
  if (badgeIds.length > 0 && badgeIds.every((id) => id === CHROME_LISTING_ID)) {
    verified.push("README: store badge matches the install listing");
  }

  return { inspected, findings, verified };
}

await runCheck(import.meta.url, {
  scan: () => scanZips(fileURLToPath(new URL("..", import.meta.url))),
  empty: "no store zip checks ran",
  failed: (count) => `${count} zip verification failure(s)`,
  passed: ({ verified }) => [...verified, "", "All store zips verified."].join("\n"),
});
