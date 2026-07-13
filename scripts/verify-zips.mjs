#!/usr/bin/env bun
// Release-artifact smoke test: every store zip must contain a manifest that
// matches its store. Right version, right name, and NEVER the dev `key`
// (a key in a store upload would break the listing's identity).
//
// One chrome zip (published unchanged to all three Chrome Web Store listing
// IDs) and one firefox zip (+ its AMO sources zip). Zips are discovered by
// version+browser suffix so the artifact template in wxt.config.ts stays the
// only place the full filename pattern is written down.
//
// Runs under bun (not node) so it can import the shared TS constants.

import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_NAME, POLLY_ID, UNIFIED_ID } from "../packages/constants/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const outDir = resolve(root, "apps/extension/.output");

// Deliberately duplicated from wxt.config.ts as a test oracle: a build that
// silently drops the gecko ID must fail here.
const GECKO_ID = "cloud-speech@vivswan.github.io";

let failures = 0;
const fail = (message) => {
  console.error(`✗ ${message}`);
  failures++;
};

/** Find exactly one zip ending with `-<version><suffix>`: zero means the
 *  build didn't run; several means stale artifacts from another version. */
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
};

// --- chrome ---
const chromeZip = findZip("chrome", "-chrome.zip");
const chromeManifest = chromeZip && readManifest("chrome", chromeZip);
if (chromeManifest) {
  const before = failures;
  checkCommon("chrome", chromeManifest, EXTENSION_NAME);
  if (!chromeManifest.permissions?.includes("offscreen")) {
    fail("chrome: offscreen permission missing (playback would break)");
  }
  if (!chromeManifest.minimum_chrome_version) {
    fail("chrome: minimum_chrome_version missing");
  }
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
  if (firefoxManifest.permissions?.includes("offscreen")) {
    fail("firefox: offscreen permission present; Firefox has no offscreen API");
  }
  if (firefoxManifest.minimum_chrome_version) {
    fail("firefox: minimum_chrome_version present (a chrome-only field)");
  }
  // Required for new AMO submissions since Nov 2025; WXT types the field as
  // plain strings, so a typo in wxt.config.ts would only surface here.
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
  findZip("firefox sources", "-firefox-sources.zip");
  if (failures === before) {
    console.log(`✓ firefox ok: ${firefoxManifest.name} v${firefoxManifest.version}`);
  }
}

// --- README badge (manual copy of the install-listing ID) ---
const readme = readFileSync(resolve(root, "README.md"), "utf8");
const expectedInstallId = UNIFIED_ID !== "" ? UNIFIED_ID : POLLY_ID;
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
