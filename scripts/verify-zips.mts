#!/usr/bin/env bun
// Release smoke test: every store zip carries a manifest that matches its store, with the right version,
// the right name, and never the dev `key` (a key in a store upload breaks the listing's identity). Zips
// are found by version+browser suffix so wxt.config.ts stays the only place the filename pattern is
// written down.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CHROME_LISTING_ID, EXTENSION_NAME } from "@cloud-speech/constants";
import AdmZip from "adm-zip";
import { runCheck } from "./lib/report.mts";
import { pickStoreZip } from "./lib/store-zips.mts";

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

/** A zip in memory beside its parsed directory: the local-header check reads bytes adm-zip parses but
 *  does not keep (the local filename). */
interface OpenedZip {
  archive: AdmZip;
  bytes: Buffer;
}

/** The fields adm-zip parses out of a local file header; its types declare the record loosely. */
type LocalHeader = {
  flags_desc: boolean;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  fnameLen: number;
};

const hex = (value: number): string => `0x${value.toString(16).padStart(8, "0")}`;

/**
 * Where an entry's local file header disagrees with its central directory record, or null when they agree.
 * adm-zip reads an entry by its central record alone, so a zip whose local header names or encodes the
 * entry differently (what Info-ZIP's unzip reports as a mismatch) would otherwise pass every check here.
 *
 * bit 3 set in the local flags -> its crc and sizes are zero placeholders, not compared (APPNOTE 4.4.4)
 * a local size of 0xffffffff   -> the real size sits in the zip64 extra field, not compared (APPNOTE 4.4.8)
 */
function localHeaderDisagreement(zip: Buffer, entry: AdmZip.IZipEntry): string | null {
  const central = entry.header;
  try {
    central.loadLocalHeaderFromBinary(zip);
  } catch (error) {
    return messageOf(error);
  }
  const local = central.localHeader as LocalHeader;
  // The fixed 30-byte header is followed by the filename (APPNOTE 4.3.7); adm-zip keeps only its length.
  const nameStart = central.offset + 30;
  const localName = zip.subarray(nameStart, nameStart + local.fnameLen);
  const differs: string[] = [];
  if (!localName.equals(entry.rawEntryName)) {
    differs.push(
      `name ${JSON.stringify(localName.toString("utf8"))} != ${JSON.stringify(entry.entryName)}`,
    );
  }
  if (local.method !== central.method) differs.push(`method ${local.method} != ${central.method}`);
  if (!local.flags_desc) {
    if (local.crc !== central.crc) differs.push(`crc ${hex(local.crc)} != ${hex(central.crc)}`);
    const sizes: [string, number, number][] = [
      ["compressed size", local.compressedSize, central.compressedSize],
      ["size", local.size, central.size],
    ];
    for (const [field, localSize, centralSize] of sizes) {
      if (localSize !== 0xffffffff && localSize !== centralSize) {
        differs.push(`${field} ${localSize} != ${centralSize}`);
      }
    }
  }
  return differs.length > 0 ? differs.join(", ") : null;
}

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

  const findZip = (label: string, suffix: string): string | null => {
    const pick = pickStoreZip(outDir, version, suffix);
    inspected++;
    if (typeof pick === "string") return resolve(outDir, pick);
    findings.push(`${label}: ${pick.problem}`);
    return null;
  };

  /** `readEntries` parses the central directory here, so a corrupt one is a finding, not a throw later. */
  const openZip = (label: string, path: string): OpenedZip | null => {
    inspected++;
    try {
      const bytes = readFileSync(path);
      return { archive: new AdmZip(bytes, { readEntries: true }), bytes };
    } catch (error) {
      findings.push(`${label}: could not read zip (${messageOf(error)})`);
      return null;
    }
  };

  /** The entry by name once its local header agrees with the central directory. A disagreement is a
   *  finding and, as for a missing entry, nothing of its content is checked. */
  const findEntry = (label: string, zip: OpenedZip, name: string): AdmZip.IZipEntry | null => {
    inspected++;
    const entry = zip.archive.getEntry(name);
    if (entry === null) {
      findings.push(`${label}: ${name} missing from zip`);
      return null;
    }
    const disagreement = localHeaderDisagreement(zip.bytes, entry);
    if (disagreement === null) return entry;
    findings.push(
      `${label}: ${name} local header disagrees with the central directory (${disagreement})`,
    );
    return null;
  };

  /** adm-zip checks the entry's CRC on read, so a corrupt entry is a finding, not a silent pass. */
  const readEntry = (label: string, zip: OpenedZip, name: string): Buffer | null => {
    const entry = findEntry(label, zip, name);
    if (entry === null) return null;
    inspected++;
    try {
      return entry.getData();
    } catch (error) {
      findings.push(`${label}: could not read ${name} from zip (${messageOf(error)})`);
      return null;
    }
  };

  const openStoreZip = (
    label: string,
    suffix: string,
  ): { zip: OpenedZip; manifest: StoreManifest } | null => {
    const path = findZip(label, suffix);
    const zip = path && openZip(label, path);
    const bytes = zip && readEntry(label, zip, "manifest.json");
    if (!zip || !bytes) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      findings.push(`${label}: could not read manifest.json from zip (${messageOf(error)})`);
      return null;
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      findings.push(`${label}: manifest.json is not an object`);
      return null;
    }
    return { zip, manifest: parsed as StoreManifest };
  };

  const checkLicense = (label: string, zip: OpenedZip): void => {
    const shipped = readEntry(label, zip, "LICENSE.md");
    if (shipped && !shipped.equals(license)) {
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
  const chrome = openStoreZip("chrome", "-chrome.zip");
  if (chrome) {
    const before = findings.length;
    checkCommon("chrome", chrome.manifest);
    // offscreen: Chrome playback runs in an offscreen document.
    checkPermissions("chrome", chrome.manifest, [...BASE_PERMISSIONS, "offscreen"]);
    check(
      Boolean(chrome.manifest.minimum_chrome_version),
      "chrome: minimum_chrome_version missing",
    );
    checkLicense("chrome", chrome.zip);
    if (findings.length === before) {
      verified.push(`chrome ok: ${chrome.manifest.name} v${chrome.manifest.version}`);
    }
  }

  // --- firefox ---
  const firefox = openStoreZip("firefox", "-firefox.zip");
  if (firefox) {
    const before = findings.length;
    const firefoxManifest = firefox.manifest;
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
    checkLicense("firefox", firefox.zip);
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
    const sources = sourcesZip && openZip("firefox sources", sourcesZip);
    // README's rebuild steps send AMO reviewers to .bun-version; WXT's source glob skips dotfiles unless
    // wxt.config.ts includes it explicitly.
    if (sources) findEntry("firefox sources", sources, ".bun-version");
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
