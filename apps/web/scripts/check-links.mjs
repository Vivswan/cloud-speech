#!/usr/bin/env bun
// Build assertion: no built page may ship an empty href (the browser resolves
// href="" to the page itself, a self-linking anchor). The StoreListing union
// in packages/constants forces TypeScript consumers to narrow on `status`
// before touching a URL; this scan is the backstop for anything the type
// system can't see. Runs after `astro build` (see the build script in
// package.json).

import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distDir = resolve(webRoot, "dist");

const offenders = [];
for (const entry of readdirSync(distDir, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
  const file = resolve(entry.parentPath, entry.name);
  if (/\bhref=(""|'')/.test(readFileSync(file, "utf8"))) {
    offenders.push(relative(distDir, file));
  }
}

if (offenders.length > 0) {
  console.error(
    `check-links: ${offenders.length} built page(s) carry an empty href:\n` +
      offenders.map((file) => `  ${file}`).join("\n"),
  );
  process.exit(1);
}
console.log("check-links: no empty hrefs in dist");
