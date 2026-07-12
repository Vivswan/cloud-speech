#!/usr/bin/env node
// Release-artifact smoke test: every store zip must contain a manifest that
// matches its listing — right version, right name, and NEVER the dev `key`
// (a key in a store upload would break the listing's identity).

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")).version;
const outDir = resolve(root, "apps/extension/.output");

const EXPECTED_NAMES = {
  cloud: "Cloud Speech for Chrome",
  polly: "Polly for Chrome",
  azure: "Azure Speech for Chrome",
};

let failures = 0;
const fail = (message) => {
  console.error(`✗ ${message}`);
  failures++;
};

for (const [mode, expectedName] of Object.entries(EXPECTED_NAMES)) {
  const zip = resolve(outDir, `cloud-speech-for-chrome-${version}-${mode}.zip`);
  if (!existsSync(zip)) {
    fail(`${mode}: zip missing at ${zip}`);
    continue;
  }

  let manifest;
  try {
    manifest = JSON.parse(execSync(`unzip -p "${zip}" manifest.json`, { encoding: "utf8" }));
  } catch (error) {
    fail(`${mode}: could not read manifest.json from zip (${error.message})`);
    continue;
  }

  if (manifest.version !== version) {
    fail(`${mode}: manifest version ${manifest.version} ≠ package version ${version}`);
  }
  if (manifest.name !== expectedName) {
    fail(`${mode}: manifest name "${manifest.name}" ≠ "${expectedName}"`);
  }
  if (manifest.key) {
    fail(`${mode}: manifest contains the dev "key" — must never ship to the store`);
  }
  if (manifest.manifest_version !== 3) {
    fail(`${mode}: manifest_version ${manifest.manifest_version} ≠ 3`);
  }
  if (!manifest.default_locale) {
    fail(`${mode}: default_locale missing (locales won't load)`);
  }

  if (failures === 0) {
    console.log(`✓ ${mode}: ${manifest.name} v${manifest.version} — ok`);
  }
}

if (failures > 0) {
  console.error(`\n${failures} zip verification failure(s)`);
  process.exit(1);
}
console.log("\nAll store zips verified.");
