#!/usr/bin/env bun
// One store submission for update-release.yml: `bun scripts/submit-store.mts <chrome|firefox>`. The
// credentials are the environment variables publish-browser-extension (behind `wxt submit`) reads by
// name, so the workflow's env block and STORES below must agree. A step without its secrets passes with
// a notice on purpose: a checkout without store credentials still releases, with the zips on GitHub only.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { invokedDirectly } from "./lib/report.mts";
import { pickStoreZip } from "./lib/store-zips.mts";

const EXTENSION_DIR = "apps/extension";
const OUT_DIR = ".output";

interface Store {
  /** The variables the workflow sets from secrets, under the names wxt submit reads. */
  env: readonly string[];
  notice: string;
  /** Each zip flag with its file's suffix after `-<version>`; the full name pattern stays written only in
   *  wxt.config.ts, and verify:zips asserted one match per suffix earlier in the same job. */
  zips: readonly { flag: string; suffix: string }[];
}

export const STORES = {
  chrome: {
    env: [
      "CHROME_CLIENT_ID",
      "CHROME_CLIENT_SECRET",
      "CHROME_REFRESH_TOKEN",
      "CHROME_EXTENSION_ID",
    ],
    notice: "CWS_* secrets not fully configured; zips attached to the GitHub release only.",
    zips: [{ flag: "--chrome-zip", suffix: "-chrome.zip" }],
  },
  firefox: {
    env: ["FIREFOX_JWT_ISSUER", "FIREFOX_JWT_SECRET", "FIREFOX_EXTENSION_ID"],
    notice: "AMO_* secrets not configured; firefox zip attached to the GitHub release only.",
    zips: [
      { flag: "--firefox-zip", suffix: "-firefox.zip" },
      { flag: "--firefox-sources-zip", suffix: "-firefox-sources.zip" },
    ],
  },
} satisfies Record<string, Store>;

export type StoreId = keyof typeof STORES;

type Runner = (args: string[], cwd: string) => number;

type Outcome =
  | { kind: "skipped"; notice: string; missing: string[] }
  | { kind: "ran"; status: number };

export function submitStore(
  id: StoreId,
  options: { root: string; env: NodeJS.ProcessEnv; run: Runner },
): Outcome {
  const store = STORES[id];
  // GitHub renders an absent secret as the empty string, so empty and unset are the same answer.
  const missing = store.env.filter((name) => !options.env[name]);
  if (missing.length > 0) return { kind: "skipped", notice: store.notice, missing };
  const { version } = JSON.parse(readFileSync(join(options.root, "package.json"), "utf8")) as {
    version: string;
  };
  const cwd = join(options.root, EXTENSION_DIR);
  const outDir = join(cwd, OUT_DIR);
  const args = ["wxt", "submit"];
  for (const { flag, suffix } of store.zips) {
    const pick = pickStoreZip(outDir, version, suffix);
    if (typeof pick !== "string") {
      const named = pick.found.length === 0 ? "" : `: ${pick.found.join(", ")}`;
      throw new Error(`${pick.problem}${named}`);
    }
    args.push(flag, join(OUT_DIR, pick));
  }
  return { kind: "ran", status: options.run(args, cwd) };
}

const runWithBunx: Runner = (args, cwd) => {
  console.log(`$ bunx ${args.join(" ")}`);
  const result = spawnSync("bunx", args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  return result.status ?? 1;
};

const isStoreId = (value: string): value is StoreId => Object.hasOwn(STORES, value);

function main(): number {
  const [id, ...rest] = process.argv.slice(2);
  if (id === undefined || rest.length > 0 || !isStoreId(id)) {
    console.error(`x usage: bun scripts/submit-store.mts <${Object.keys(STORES).join("|")}>`);
    return 2;
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  let outcome: Outcome;
  try {
    outcome = submitStore(id, { root, env: process.env, run: runWithBunx });
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(`x ${error.message}`);
    return 1;
  }
  if (outcome.kind === "skipped") {
    console.log(`::notice::${outcome.notice}`);
    console.log(`empty: ${outcome.missing.join(", ")}`);
    return 0;
  }
  return outcome.status;
}

if (invokedDirectly(import.meta.url)) process.exit(main());
