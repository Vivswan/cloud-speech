import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CHROME_LISTING_ID, EXTENSION_NAME } from "@cloud-speech/constants";
import AdmZip from "adm-zip";
import { describe, expect, it } from "vitest";
import { scanZips } from "../../../../scripts/verify-zips.mts";

// What the source does not say: adm-zip checks an entry's CRC on read, so a corrupt entry reaches
// readEntry's catch.

const VERSION = "2.0.0";
const LICENSE = "# License\n\nExample terms.\n";
const BASE_PERMISSIONS = ["contextMenus", "downloads", "storage", "scripting"];

const COMMON = {
  version: VERSION,
  name: EXTENSION_NAME,
  manifest_version: 3,
  default_locale: "en",
  host_permissions: ["<all_urls>"],
};
const CHROME_MANIFEST = {
  ...COMMON,
  permissions: [...BASE_PERMISSIONS, "offscreen"],
  minimum_chrome_version: "116",
};
const FIREFOX_MANIFEST = {
  ...COMMON,
  permissions: BASE_PERMISSIONS,
  background: { scripts: ["background.js"] },
  browser_specific_settings: {
    gecko: {
      id: "cloud-speech@vivswan",
      data_collection_permissions: { required: ["websiteContent", "authenticationInfo"] },
    },
  },
};

function zip(entries: Record<string, string>): Buffer {
  const archive = new AdmZip();
  for (const [name, text] of Object.entries(entries)) archive.addFile(name, Buffer.from(text));
  return archive.toBuffer();
}

function storeZip(manifest: unknown, license: string | null): Buffer {
  const entries: Record<string, string> = { "manifest.json": JSON.stringify(manifest) };
  if (license !== null) entries["LICENSE.md"] = license;
  return zip(entries);
}

/** The same zip with LICENSE.md's recorded CRC off by one bit in both headers, its bytes untouched.
 *  Unsigned on purpose: adm-zip clamps a negative CRC to zero. */
function withBadLicenseCrc(bytes: Buffer): Buffer {
  const archive = new AdmZip(bytes);
  const entry = archive.getEntry("LICENSE.md");
  if (entry === null) throw new Error("the fixture has no LICENSE.md");
  entry.header.crc = (entry.header.crc ^ 1) >>> 0;
  return archive.toBuffer();
}

function fixture(chrome: Buffer): string {
  const root = mkdtempSync(join(tmpdir(), "verify-zips-"));
  try {
    writeFileSync(join(root, "package.json"), JSON.stringify({ version: VERSION }));
    writeFileSync(join(root, "LICENSE.md"), LICENSE);
    writeFileSync(
      join(root, "README.md"),
      `[store](https://chromewebstore.google.com/detail/${CHROME_LISTING_ID})\n`,
    );
    const outDir = join(root, "apps/extension/.output");
    mkdirSync(outDir, { recursive: true });
    writeFileSync(join(outDir, `cloud-speech-${VERSION}-chrome.zip`), chrome);
    writeFileSync(
      join(outDir, `cloud-speech-${VERSION}-firefox.zip`),
      storeZip(FIREFOX_MANIFEST, LICENSE),
    );
    writeFileSync(
      join(outDir, `cloud-speech-${VERSION}-firefox-sources.zip`),
      zip({ ".bun-version": "1.0.0\n", "package.json": "{}\n" }),
    );
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
  return root;
}

const CHROME_OK = `chrome ok: ${EXTENSION_NAME} v${VERSION}`;
const OTHERS_OK = [
  `firefox ok: ${EXTENSION_NAME} v${VERSION}`,
  "README: store badge matches the install listing",
];

describe("verify-zips on hand-built store zips", () => {
  it.each<[string, Buffer, unknown[], string[]]>([
    [
      "healthy zips pass every check",
      storeZip(CHROME_MANIFEST, LICENSE),
      [],
      [CHROME_OK, ...OTHERS_OK],
    ],
    [
      "a LICENSE.md whose CRC does not match its bytes is one finding",
      withBadLicenseCrc(storeZip(CHROME_MANIFEST, LICENSE)),
      [expect.stringMatching(/^chrome: could not read LICENSE\.md from zip \(.*CRC/)],
      OTHERS_OK,
    ],
    [
      "a zip without LICENSE.md is one finding while the other checks still run",
      storeZip(CHROME_MANIFEST, null),
      ["chrome: LICENSE.md missing from zip"],
      OTHERS_OK,
    ],
    [
      "a manifest.json that is not an object is one finding while the other checks still run",
      storeZip(null, LICENSE),
      ["chrome: manifest.json is not an object"],
      OTHERS_OK,
    ],
  ])("%s", (_label, chrome, findings, verified) => {
    const root = fixture(chrome);
    try {
      const result = scanZips(root);
      expect({ findings: result.findings, verified: result.verified }).toEqual({
        findings,
        verified,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
