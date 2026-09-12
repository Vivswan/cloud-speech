#!/usr/bin/env bun
// Release smoke test: every store zip carries a manifest that matches its store, with the right version,
// the right name, and never the dev `key` (a key in a store upload breaks the listing's identity). Zips
// are found by version+browser suffix so wxt.config.ts stays the only place the filename pattern is
// written down.

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// A .ts import from a .mjs file: this script runs under bun, not node.
import { EXTENSION_NAME, UNIFIED_ID } from "../packages/constants/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const outDir = resolve(root, "apps/extension/.output");

// Deliberately duplicated from wxt.config.ts as a test oracle: a build that silently drops the gecko ID
// must fail here.
const GECKO_ID = "cloud-speech@vivswan.github.io";

let failures = 0;
const fail = (message) => {
  console.error(`✗ ${message}`);
  failures++;
};

/** Exactly one: several means a stray copy of this version's zip is in the way. */
const findZip = (label, suffix) => {
  const wanted = `-${version}${suffix}`;
  const matches = readdirSync(outDir).filter((name) => name.endsWith(wanted));
  if (matches.length !== 1) {
    fail(`${label}: expected exactly one *${wanted} in ${outDir}, found ${matches.length}`);
    return null;
  }
  return resolve(outDir, matches[0]);
};

const readManifest = (label, zip) => {
  try {
    return JSON.parse(execSync(`unzip -p "${zip}" manifest.json`, { encoding: "utf8" }));
  } catch (error) {
    fail(`${label}: could not read manifest.json from zip (${error.message})`);
    return null;
  }
};

// The package is what users install, so it must carry the same terms the store listing shows
// (wxt.config.ts copies the root file in through build:publicAssets).
const license = readFileSync(resolve(root, "LICENSE.md"));
const checkLicense = (label, zip) => {
  let shipped;
  try {
    shipped = execSync(`unzip -p "${zip}" LICENSE.md`, { encoding: "buffer" });
  } catch (error) {
    fail(`${label}: LICENSE.md missing from zip (${error.message})`);
    return;
  }
  if (!shipped.equals(license)) {
    fail(`${label}: LICENSE.md in zip differs from the repository's LICENSE.md`);
  }
};

const checkCommon = (label, manifest, expectedName) => {
  if (manifest.version !== version) {
    fail(`${label}: manifest version ${manifest.version} ≠ package version ${version}`);
  }
  if (manifest.name !== expectedName) {
    fail(`${label}: manifest name "${manifest.name}" ≠ "${expectedName}"`);
  }
  if (manifest.key) {
    fail(`${label}: manifest contains the dev "key", which must never ship to the store`);
  }
  if (manifest.manifest_version !== 3) {
    fail(`${label}: manifest_version ${manifest.manifest_version} ≠ 3`);
  }
  if (!manifest.default_locale) {
    fail(`${label}: default_locale missing (locales won't load)`);
  }
  if (JSON.stringify(manifest.host_permissions) !== JSON.stringify(["<all_urls>"])) {
    fail(
      `${label}: host_permissions ${JSON.stringify(manifest.host_permissions)} ≠ ["<all_urls>"]`,
    );
  }
};

// Pinned exactly, not as a floor: the stores reject any permission the extension does not need, so a
// new one must be added here on purpose.
const checkPermissions = (label, manifest, expected) => {
  const declared = (manifest.permissions ?? []).slice().sort();
  if (JSON.stringify(declared) !== JSON.stringify(expected.slice().sort())) {
    fail(
      `${label}: permissions ${JSON.stringify(manifest.permissions)} ≠ ${JSON.stringify(expected)}`,
    );
  }
};
const BASE_PERMISSIONS = ["contextMenus", "downloads", "storage", "scripting"];

// --- chrome ---
const chromeZip = findZip("chrome", "-chrome.zip");
const chromeManifest = chromeZip && readManifest("chrome", chromeZip);
if (chromeManifest) {
  const before = failures;
  checkCommon("chrome", chromeManifest, EXTENSION_NAME);
  // offscreen: Chrome playback runs in an offscreen document.
  checkPermissions("chrome", chromeManifest, [...BASE_PERMISSIONS, "offscreen"]);
  if (!chromeManifest.minimum_chrome_version) {
    fail("chrome: minimum_chrome_version missing");
  }
  checkLicense("chrome", chromeZip);
  if (failures === before) {
    console.log(`✓ chrome ok: ${chromeManifest.name} v${chromeManifest.version}`);
  }
}

// --- firefox ---
const firefoxZip = findZip("firefox", "-firefox.zip");
const firefoxManifest = firefoxZip && readManifest("firefox", firefoxZip);
if (firefoxManifest) {
  const before = failures;
  checkCommon("firefox", firefoxManifest, EXTENSION_NAME);
  if (firefoxManifest.browser_specific_settings?.gecko?.id !== GECKO_ID) {
    fail(
      `firefox: gecko id "${firefoxManifest.browser_specific_settings?.gecko?.id}" ≠ "${GECKO_ID}"`,
    );
  }
  if (!firefoxManifest.background?.scripts?.length) {
    fail("firefox: background.scripts missing (event page required)");
  }
  if (firefoxManifest.background?.service_worker) {
    fail("firefox: background.service_worker present; Firefox needs an event page");
  }
  // No offscreen: Firefox has no offscreen API; audio plays in the event page.
  checkPermissions("firefox", firefoxManifest, BASE_PERMISSIONS);
  if (firefoxManifest.minimum_chrome_version) {
    fail("firefox: minimum_chrome_version present (a chrome-only field)");
  }
  checkLicense("firefox", firefoxZip);
  // Required for new AMO submissions since Nov 2025. Pinned as a whole list: WXT types the field as plain
  // strings, so a category dropped or added in wxt.config.ts would pass the type check.
  const declared = firefoxManifest.browser_specific_settings?.gecko?.data_collection_permissions;
  const expectedDataCollection = ["websiteContent", "authenticationInfo"];
  if (
    JSON.stringify(declared?.required?.slice().sort()) !==
    JSON.stringify(expectedDataCollection.slice().sort())
  ) {
    fail(
      `firefox: gecko.data_collection_permissions.required ${JSON.stringify(declared?.required)} ` +
        `≠ ${JSON.stringify(expectedDataCollection)}`,
    );
  }
  const sourcesZip = findZip("firefox sources", "-firefox-sources.zip");
  if (sourcesZip) {
    // README's rebuild steps send AMO reviewers to .bun-version; WXT's source glob skips dotfiles unless
    // wxt.config.ts includes it explicitly.
    const entries = execSync(`unzip -Z1 "${sourcesZip}"`, { encoding: "utf8" }).split("\n");
    if (!entries.includes(".bun-version")) {
      fail("firefox sources: .bun-version missing (the README rebuild steps point at it)");
    }
  }
  if (failures === before) {
    console.log(`✓ firefox ok: ${firefoxManifest.name} v${firefoxManifest.version}`);
  }
}

// --- README badge (manual copy of the install-listing ID) ---
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const expectedInstallId = UNIFIED_ID;
const badgeIds = [
  ...readme.matchAll(/(?:chrome-web-store\/v|chromewebstore\.google\.com\/detail)\/([a-p]{32})/g),
].map((match) => match[1]);
if (badgeIds.length === 0) {
  fail("README: no Chrome Web Store badge/link found");
} else {
  for (const id of badgeIds) {
    if (id !== expectedInstallId) {
      fail(`README: store badge/link ID ${id} ≠ expected install listing ${expectedInstallId}`);
    }
  }
  if (badgeIds.every((id) => id === expectedInstallId)) {
    console.log("✓ README: store badge matches the install listing");
  }
}

if (failures > 0) {
  console.error(`\n${failures} zip verification failure(s)`);
  process.exit(1);
}
console.log("\nAll store zips verified.");
