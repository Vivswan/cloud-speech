#!/usr/bin/env bun
// Dev orchestrator: a frozen-lockfile install when bun.lock is newer than the last one, a store
// screenshot render when a set is missing or stale, then the website (Astro) in the background and the
// extension (WXT) in the foreground with the real terminal attached. Not `bun run --filter '*' dev`: the
// filter runner closes each child's stdin, and WXT's interactive key listener hits EOF and exits about 5s
// after launch, taking the dev browser with it.
//
//   bun run dev --no-install           skip the dependency check
//   CLOUD_SPEECH_DEV_SKIP_INSTALL=1    same
//   bun run dev --extension            the extension alone: the same profile reclaim and WXT child, no
//                                      website and no screenshot render (`bun run dev:extension`)
//   bun run dev:extension --port 3999  any other argument goes to WXT

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// By path: the root workspace has no dependency on the constants package.
import { SITE_LOCALES } from "../packages/constants/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const prefixLines = (tag: string, chunk: unknown): string =>
  String(chunk)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => `${tag} ${line}`)
    .join("\n");

const mtime = (file: string): number | undefined => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

// The stamp is written only by this script, after `bun install --frozen-lockfile` succeeded; a manual
// `bun install` leaves it as it was.
//   no stamp                  -> install (first launch, node_modules removed, an earlier install here failed)
//   stamp older than bun.lock -> install
//   stamp newer than bun.lock -> trusted, even when a manual install ran since
const lockfile = resolve(root, "bun.lock");
const installStamp = resolve(root, "node_modules/.cloud-speech-install-stamp");
const skipInstall =
  process.argv.includes("--no-install") || process.env.CLOUD_SPEECH_DEV_SKIP_INSTALL === "1";
const extensionOnly = process.argv.includes("--extension");
const launcherFlags = new Set(["--no-install", "--extension"]);
const wxtArgs = process.argv.slice(2).filter((arg) => !launcherFlags.has(arg));
// Only a Chromium dev-server launch may touch the Chrome profile: `wxt --help`, `wxt build` and the
// other subcommands never open it, and a Firefox or Safari launch would close an unrelated Chrome.
// The option table mirrors WXT's dev command (wxt/dist/cli/commands.mjs): these take a value, every
// other flag is a boolean, and a cluster like `-hv` is one flag per letter.
const wxtValueOptions = new Set([
  "-c",
  "--config",
  "-m",
  "--mode",
  "-b",
  "--browser",
  "--host",
  "-p",
  "--port",
  "-e",
  "--filter-entrypoint",
  "--level",
]);
const wxtSubcommands = new Set(["build", "zip", "prepare", "clean", "cleanup", "init", "submit"]);
const wxtHelpFlags = new Set(["-h", "--help", "-v", "--version"]);
let wxtBrowser = "chrome";
let wxtHelp = false;
let wxtPositional: string | undefined;
for (let i = 0; i < wxtArgs.length; i++) {
  const arg = wxtArgs[i] ?? "";
  if (!arg.startsWith("-")) {
    wxtPositional ??= arg;
    continue;
  }
  const eq = arg.indexOf("=");
  const name = eq === -1 ? arg : arg.slice(0, eq);
  let value = eq === -1 ? undefined : arg.slice(eq + 1);
  const flags = /^-[^-]{2,}$/.test(name)
    ? [...name.slice(1)].map((letter) => `-${letter}`)
    : [name];
  if (flags.some((flag) => wxtHelpFlags.has(flag))) wxtHelp = true;
  if (wxtValueOptions.has(name)) value ??= wxtArgs[++i];
  if (name === "-b" || name === "--browser") wxtBrowser = value ?? "chrome";
}
const chromiumDevServer =
  !wxtHelp &&
  !["firefox", "safari"].includes(wxtBrowser) &&
  (wxtPositional === undefined || !wxtSubcommands.has(wxtPositional));
const staleInstallReason = (): string | undefined => {
  const installed = mtime(installStamp);
  if (installed === undefined) return "no completed install is recorded";
  const locked = mtime(lockfile);
  if (locked !== undefined && locked > installed) {
    return "bun.lock is newer than the last completed install";
  }
  return undefined;
};
const staleInstall = skipInstall ? undefined : staleInstallReason();
if (skipInstall) {
  console.log(
    "[dev] Skipping the dependency check (--no-install / CLOUD_SPEECH_DEV_SKIP_INSTALL).",
  );
} else if (staleInstall === undefined) {
  console.log("[dev] Dependencies are current (installed after the last bun.lock change).");
} else {
  console.log(
    `[dev] Dependencies are out of date (${staleInstall}); running bun install --frozen-lockfile...`,
  );
  try {
    execFileSync("bun", ["install", "--frozen-lockfile"], { cwd: root, stdio: "inherit" });
  } catch (error) {
    // The one early exit dev has: every later step imports these packages.
    console.error(
      `[dev] bun install --frozen-lockfile failed (${messageOf(error)}); dev cannot start without its dependencies. Fix the install and start dev again.`,
    );
    process.exit(1);
  }
  writeFileSync(installStamp, `${new Date().toISOString()}\n`);
  console.log("[dev] Dependencies installed.");
}

// Production serves the screenshot sets CI publishes; dev renders them when a set is missing or older
// than a render input, and the website's dev server serves them to the walkthrough pages
// (docs/store-listing.md). Each set's crops.json is the renderer's completion marker, removed before the
// set's first scene and written last, so its mtime is that set's render time.
const cropsOf = (locale: string): string =>
  resolve(root, "apps/extension/.output/store-screenshots", locale, "crops.json");
const sets = SITE_LOCALES.map((locale) => locale.storeLocale);
// Everything a render is made from. bun.lock is one: an icon library bump redraws every icon without
// touching a source file.
const renderInputs = [
  "apps/extension/src",
  "packages",
  "apps/extension/tests/e2e/store-screenshots.ts",
  "apps/extension/tests/e2e/store-screenshots-copy.ts",
  "apps/extension/tests/e2e/fixtures.ts",
  "apps/extension/tests/e2e/playback-waits.ts",
  "apps/extension/tests/e2e/fake-provider",
  "apps/extension/playwright.screenshots.config.ts",
  "apps/extension/package.json",
  "apps/extension/wxt.config.ts",
  "apps/extension/tsconfig.json",
  "bun.lock",
].map((path) => resolve(root, path));
const SKIPPED_DIRS = new Set(["node_modules", ".output", ".wxt"]);
interface NewestFile {
  file: string;
  mtimeMs: number;
}
const newestFile = (path: string): NewestFile | undefined => {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  if (!stats.isDirectory()) return { file: path, mtimeMs: stats.mtimeMs };
  let newest: NewestFile | undefined;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const found = newestFile(join(path, entry.name));
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  return newest;
};
const staleReason = (): string | undefined => {
  let rendered: number | undefined;
  for (const set of sets) {
    const marker = mtime(cropsOf(set));
    if (marker === undefined) return `no complete render of the ${set} set exists`;
    if (rendered === undefined || marker < rendered) rendered = marker;
  }
  let newest: NewestFile | undefined;
  for (const input of renderInputs) {
    const found = newestFile(input);
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  if (newest && rendered !== undefined && newest.mtimeMs > rendered) {
    return `${relative(root, newest.file)} changed after the last render`;
  }
  return undefined;
};
const stale = extensionOnly ? undefined : staleReason();
if (extensionOnly) {
  console.log("[dev] Extension only (--extension): no website, no screenshot render.");
} else if (stale === undefined) {
  console.log(
    "[dev] Store screenshots are current (apps/extension/.output/store-screenshots, every language); not rendering.",
  );
} else {
  console.log(
    `[dev] Rendering the store screenshots for the walkthrough page (${stale}): bun run screenshots:store...`,
  );
  // The renderer removes a marker only once Playwright reaches its set; a failure before that (the
  // extension build, say) would leave the old markers looking current.
  for (const set of sets) rmSync(cropsOf(set), { force: true });
  const output: string[] = [];
  const render = spawn("bun", ["run", "screenshots:store"], {
    cwd: root,
    stdio: ["ignore", "pipe", "pipe"],
  });
  render.stdout.on("data", (c) => {
    output.push(String(c));
    console.log(prefixLines("[render]", c));
  });
  render.stderr.on("data", (c) => {
    output.push(String(c));
    console.error(prefixLines("[render]", c));
  });
  // A spawn failure (no `bun` on the child's PATH, say) emits `error` instead of `exit`; unhandled, it
  // would end dev here. `close` follows both.
  let spawnError: Error | undefined;
  render.on("error", (error) => {
    spawnError = error;
  });
  const code = await new Promise<number | null>((done) => render.on("close", done));
  if (spawnError) {
    console.error(
      `[dev] Store screenshots render could not start (${spawnError.message}); the walkthrough page uses the published screenshots from GitHub until a local render exists.`,
    );
  } else if (code === 0) {
    console.log("[dev] Store screenshots rendered.");
  } else {
    console.error(
      `[dev] Store screenshots render failed (exit ${code}); the walkthrough page uses the published screenshots from GitHub until a local render exists.`,
    );
    // Playwright's wording when its browser download is missing.
    if (output.join("").includes("Executable doesn't exist")) {
      console.error(
        "[dev] Playwright's Chromium is not installed. Install it, then start dev again:",
      );
      console.error("[dev]   cd apps/extension && bunx playwright install chromium");
    }
  }
}

// The dev browser's persistent profile; wxt.config.ts (webExt.chromiumProfile) names the same path.
const profileDir = resolve(root, "apps/extension/.wxt/chrome-data");
// execFile, no shell: the path must reach pgrep and pkill as ONE argument, never re-parsed by a shell.
const profileMatch = `user-data-dir=${profileDir}`;
const browserAlive = (): boolean => {
  const probe = spawnSync("pgrep", ["-f", profileMatch], { stdio: "ignore" });
  // pgrep exits 1 for "no match"; anything else is a failed probe, not an absent browser.
  if (probe.status === 0) return true;
  if (probe.status === 1) return false;
  throw new Error(`pgrep failed: ${probe.error?.message ?? `exit ${probe.status}`}`);
};

// A browser still holding the profile makes the new launch hand its URLs to that instance and exit at
// once, so a leftover one is closed first.
const reclaimChromeProfile = (): void => {
  if (browserAlive()) {
    console.log("[dev] Closing the browser left from the previous dev session...");
    try {
      execFileSync("pkill", ["-f", profileMatch], { stdio: "ignore" });
    } catch {
      // Nothing matched: it exited between the check and the kill.
    }
    const deadline = Date.now() + 3000;
    while (browserAlive() && Date.now() < deadline) Bun.sleepSync(100);
    if (browserAlive()) {
      console.warn("[dev] A browser still holds the dev profile; the launch may fail.");
    }
  }
  // chrome://extensions Developer mode is a tracked pref ("Secure Preferences"): a copy of it in the
  // plain Preferences file registers as tampering and resets the toggle on every launch. Chrome writes
  // that copy on exit, hence after the reclaim above.
  try {
    const prefsFile = resolve(profileDir, "Default/Preferences");
    if (existsSync(prefsFile)) {
      const prefs = JSON.parse(readFileSync(prefsFile, "utf8"));
      if (prefs.extensions?.ui && "developer_mode" in prefs.extensions.ui) {
        delete prefs.extensions.ui.developer_mode;
        writeFileSync(prefsFile, JSON.stringify(prefs));
      }
    }
  } catch (error) {
    console.warn(`[dev] Could not clean the dev profile's Preferences: ${messageOf(error)}`);
  }
};
if (chromiumDevServer) {
  reclaimChromeProfile();
} else {
  console.log("[dev] Not a Chrome dev-server launch; the dev profile is left alone.");
}

// Detached, so shutdown can signal the whole process group: `bun run dev` wraps the real `astro dev`
// process, and killing only the wrapper orphans astro, which then squats on port 5173 across sessions.
// The server stays in that group because the web dev script sets ASTRO_DEV_BACKGROUND, which turns
// off the agent detection (am-i-vibing) that makes Astro daemonize it out of the group.
const web = extensionOnly
  ? undefined
  : spawn("bun", ["run", "dev"], {
      cwd: resolve(root, "apps/web"),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
// Negative pid: the wrapper's process group, which holds astro too. Signal 0 only probes it.
const signalWebGroup = (signal: NodeJS.Signals | 0): boolean => {
  if (web?.pid === undefined) return false;
  try {
    process.kill(-web.pid, signal);
    return true;
  } catch {
    return false;
  }
};
let webStopping: Promise<void> | undefined;
const stopWeb = (): Promise<void> => {
  webStopping ??= (async () => {
    if (!signalWebGroup("SIGTERM")) return;
    const deadline = Date.now() + 5000;
    while (signalWebGroup(0) && Date.now() < deadline) await Bun.sleep(100);
    if (signalWebGroup(0)) {
      console.error("[web] still running 5s after SIGTERM; killing the process group.");
      signalWebGroup("SIGKILL");
    }
  })();
  return webStopping;
};
web?.stdout.on("data", (c) => console.log(prefixLines("[web]", c)));
web?.stderr.on("data", (c) => console.error(prefixLines("[web]", c)));

// stdin is inherited, not piped: WXT's key listener (`o` + enter reopens the browser) only starts when
// its stdin is a TTY.
const wxt = spawn("bun", ["run", "dev", ...wxtArgs], {
  cwd: resolve(root, "apps/extension"),
  stdio: "inherit",
});

const shutdown = (): void => {
  void stopWeb();
  wxt.kill("SIGTERM");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

wxt.on("exit", async (code) => {
  await stopWeb();
  process.exit(code ?? 0);
});
web?.on("exit", (code) => {
  if (code !== 0 && code !== null) console.error(`[web] exited with code ${code}`);
});
