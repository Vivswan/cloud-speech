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
import { messageOf } from "./lib/errors.mts";
import { runCheck } from "./lib/report.mts";
import { pickStoreZip } from "./lib/store-zips.mts";

// Duplicated from wxt.config.ts on purpose, as the oracle: a build that silently drops the gecko ID must fail here.
const GECKO_ID = "cloud-speech@vivswan";

// Pinned exactly, not as a floor: the stores reject an unneeded permission, so a new one must be added here on purpose.
const BASE_PERMISSIONS = ["contextMenus", "downloads", "storage", "scripting"];

// Required for new AMO submissions since Nov 2025, pinned as a whole list: WXT types the field as plain strings.
const DATA_COLLECTION = ["websiteContent", "authenticationInfo"];

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

/** A zip in memory beside its parsed directory: the local-header check reads bytes adm-zip parses but
 *  does not keep (the local filename). */
interface OpenedZip {
  archive: AdmZip;
  bytes: Buffer;
}

interface StoreZip {
  zip: OpenedZip;
  manifest: StoreManifest;
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

/** One release's zips, held to one package version, one LICENSE.md, and one output directory. Every
 *  check counts toward `inspected`; a failed one writes its line to `findings`. */
class Release {
  /** Checks run, zip found or not; zero fails the run. */
  inspected = 0;

  /** One line per failed check, in check order. */
  readonly findings: string[] = [];

  /** One line per store, and the README, whose checks all passed. */
  readonly verified: string[] = [];

  /** The repository root the zips and the README are read under. */
  readonly root: string;

  /** The version every manifest must carry, from the root package.json. */
  private readonly version: string;

  /** Where the store builds write their zips. */
  private readonly outDir: string;

  /** The terms the store listing shows; wxt.config.ts copies this root file into each zip (build:publicAssets). */
  private readonly license: Buffer;

  constructor(root: string) {
    const pkg = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
      version: string;
    };
    this.root = root;
    this.version = pkg.version;
    this.outDir = resolve(root, "apps/extension/.output");
    this.license = readFileSync(resolve(root, "LICENSE.md"));
  }

  check(holds: boolean, message: string): void {
    this.inspected++;
    if (!holds) this.findings.push(message);
  }

  /** The zip's path, or null (and a finding) when the output directory holds no single match. */
  findZip(label: string, suffix: string): string | null {
    const pick = pickStoreZip(this.outDir, this.version, suffix);
    this.inspected++;
    if (typeof pick === "string") return resolve(this.outDir, pick);

    this.findings.push(`${label}: ${pick.problem}`);
    return null;
  }

  /** `readEntries` parses the central directory here, so a corrupt one is a finding, not a throw later. */
  openZip(label: string, path: string): OpenedZip | null {
    this.inspected++;
    try {
      const bytes = readFileSync(path);
      return { archive: new AdmZip(bytes, { readEntries: true }), bytes };
    } catch (error) {
      this.findings.push(`${label}: could not read zip (${messageOf(error)})`);
      return null;
    }
  }

  /** The entry by name once its local header agrees with the central directory. A disagreement is a
   *  finding and, as for a missing entry, nothing of its content is checked. */
  findEntry(label: string, zip: OpenedZip, name: string): AdmZip.IZipEntry | null {
    this.inspected++;
    const entry = zip.archive.getEntry(name);
    if (entry === null) {
      this.findings.push(`${label}: ${name} missing from zip`);
      return null;
    }

    const disagreement = localHeaderDisagreement(zip.bytes, entry);
    if (disagreement === null) return entry;

    this.findings.push(
      `${label}: ${name} local header disagrees with the central directory (${disagreement})`,
    );
    return null;
  }

  /** adm-zip checks the entry's CRC on read, so a corrupt entry is a finding, not a silent pass. */
  readEntry(label: string, zip: OpenedZip, name: string): Buffer | null {
    const entry = this.findEntry(label, zip, name);
    if (entry === null) return null;

    this.inspected++;
    try {
      return entry.getData();
    } catch (error) {
      this.findings.push(`${label}: could not read ${name} from zip (${messageOf(error)})`);
      return null;
    }
  }

  /** The store zip with its manifest parsed, or null once a step on the way was a finding. */
  openStoreZip(label: string, suffix: string): StoreZip | null {
    const path = this.findZip(label, suffix);
    if (path === null) return null;

    const zip = this.openZip(label, path);
    if (zip === null) return null;

    const bytes = this.readEntry(label, zip, "manifest.json");
    if (bytes === null) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      this.findings.push(`${label}: could not read manifest.json from zip (${messageOf(error)})`);
      return null;
    }

    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      this.findings.push(`${label}: manifest.json is not an object`);
      return null;
    }

    return { zip, manifest: parsed as StoreManifest };
  }

  checkLicense(label: string, zip: OpenedZip): void {
    const shipped = this.readEntry(label, zip, "LICENSE.md");
    if (shipped && !shipped.equals(this.license)) {
      this.findings.push(`${label}: LICENSE.md in zip differs from the repository's LICENSE.md`);
    }
  }

  checkCommon(label: string, manifest: StoreManifest): void {
    this.check(
      manifest.version === this.version,
      `${label}: manifest version ${manifest.version} != package version ${this.version}`,
    );
    this.check(
      manifest.name === EXTENSION_NAME,
      `${label}: manifest name "${manifest.name}" != "${EXTENSION_NAME}"`,
    );
    this.check(
      !manifest.key,
      `${label}: manifest contains the dev "key", which must never ship to the store`,
    );
    this.check(
      manifest.manifest_version === 3,
      `${label}: manifest_version ${manifest.manifest_version} != 3`,
    );
    this.check(
      Boolean(manifest.default_locale),
      `${label}: default_locale missing (locales won't load)`,
    );
    this.check(
      JSON.stringify(manifest.host_permissions) === JSON.stringify(["<all_urls>"]),
      `${label}: host_permissions ${JSON.stringify(manifest.host_permissions)} != ["<all_urls>"]`,
    );
  }

  checkPermissions(label: string, manifest: StoreManifest, expected: readonly string[]): void {
    const declared = (manifest.permissions ?? []).slice().sort();
    this.check(
      JSON.stringify(declared) === JSON.stringify(expected.slice().sort()),
      `${label}: permissions ${JSON.stringify(manifest.permissions)} != ${JSON.stringify(expected)}`,
    );
  }
}

/** Chrome plays audio in an offscreen document, so its manifest must carry the offscreen permission and a minimum_chrome_version. */
function checkChrome(release: Release): void {
  const chrome = release.openStoreZip("chrome", "-chrome.zip");
  if (chrome === null) return;

  const before = release.findings.length;
  release.checkCommon("chrome", chrome.manifest);
  release.checkPermissions("chrome", chrome.manifest, [...BASE_PERMISSIONS, "offscreen"]);
  release.check(
    Boolean(chrome.manifest.minimum_chrome_version),
    "chrome: minimum_chrome_version missing",
  );
  release.checkLicense("chrome", chrome.zip);

  if (release.findings.length === before) {
    release.verified.push(`chrome ok: ${chrome.manifest.name} v${chrome.manifest.version}`);
  }
}

/** The AMO sources zip carries .bun-version: README's rebuild steps send reviewers to it, and WXT's
 *  source glob skips dotfiles unless wxt.config.ts includes it explicitly. */
function checkFirefoxSources(release: Release): void {
  const path = release.findZip("firefox sources", "-firefox-sources.zip");
  if (path === null) return;

  const sources = release.openZip("firefox sources", path);
  if (sources === null) return;

  release.findEntry("firefox sources", sources, ".bun-version");
}

/** Firefox has no offscreen API, so audio plays in the event page: no offscreen permission and no Chrome-only field, and AMO wants the sources zip beside it. */
function checkFirefox(release: Release): void {
  const firefox = release.openStoreZip("firefox", "-firefox.zip");
  if (firefox === null) return;

  const before = release.findings.length;
  const { manifest } = firefox;
  release.checkCommon("firefox", manifest);
  const geckoId = manifest.browser_specific_settings?.gecko?.id;
  release.check(geckoId === GECKO_ID, `firefox: gecko id "${geckoId}" != "${GECKO_ID}"`);
  release.check(
    Boolean(manifest.background?.scripts?.length),
    "firefox: background.scripts missing (event page required)",
  );
  release.check(
    !manifest.background?.service_worker,
    "firefox: background.service_worker present; Firefox needs an event page",
  );
  release.checkPermissions("firefox", manifest, BASE_PERMISSIONS);
  release.check(
    !manifest.minimum_chrome_version,
    "firefox: minimum_chrome_version present (a chrome-only field)",
  );
  release.checkLicense("firefox", firefox.zip);
  const declared = manifest.browser_specific_settings?.gecko?.data_collection_permissions?.required;
  release.check(
    JSON.stringify(declared?.slice().sort()) === JSON.stringify(DATA_COLLECTION.slice().sort()),
    `firefox: gecko.data_collection_permissions.required ${JSON.stringify(declared)} ` +
      `!= ${JSON.stringify(DATA_COLLECTION)}`,
  );
  checkFirefoxSources(release);

  if (release.findings.length === before) {
    release.verified.push(`firefox ok: ${manifest.name} v${manifest.version}`);
  }
}

/** The README's store badge and install link carry the listing ID by hand, so each is held to
 *  CHROME_LISTING_ID. */
function checkReadmeBadge(release: Release): void {
  const readme = readFileSync(resolve(release.root, "README.md"), "utf8");
  const badgeIds = [
    ...readme.matchAll(/(?:chrome-web-store\/v|chromewebstore\.google\.com\/detail)\/([a-p]{32})/g),
  ].map((match) => match[1]);

  release.check(badgeIds.length > 0, "README: no Chrome Web Store badge/link found");
  for (const id of badgeIds) {
    release.check(
      id === CHROME_LISTING_ID,
      `README: store badge/link ID ${id} != expected install listing ${CHROME_LISTING_ID}`,
    );
  }

  if (badgeIds.length > 0 && badgeIds.every((id) => id === CHROME_LISTING_ID)) {
    release.verified.push("README: store badge matches the install listing");
  }
}

export function scanZips(root: string): {
  inspected: number;
  findings: string[];
  verified: string[];
} {
  const release = new Release(root);
  checkChrome(release);
  checkFirefox(release);
  checkReadmeBadge(release);
  return { inspected: release.inspected, findings: release.findings, verified: release.verified };
}

if (import.meta.main) {
  await runCheck({
    scan: () => scanZips(fileURLToPath(new URL("..", import.meta.url))),
    empty: "no store zip checks ran",
    failed: (count) => `${count} zip verification failure(s)`,
    passed: ({ verified }) => [...verified, "", "All store zips verified."].join("\n"),
  });
}
