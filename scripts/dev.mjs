#!/usr/bin/env node
// Dev orchestrator: a frozen-lockfile install when bun.lock is newer than the last one, a store
// screenshot render when a set is missing or stale, then the website (Astro) in the background and the
// extension (WXT) in the foreground with the real terminal attached. Not `bun run --filter '*' dev`: the
// filter runner closes each child's stdin, and WXT's interactive key listener hits EOF and exits about 5s
// after launch, taking the dev browser with it.
//
//   bun run dev --no-install           skip the dependency check
//   CLOUD_SPEECH_DEV_SKIP_INSTALL=1    same

import { execFileSync, spawn } from "node:child_process";
import { readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// By path: the root workspace has no dependency on the constants package.
import { SITE_LOCALES } from "../packages/constants/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const prefixLines = (tag, chunk) =>
  String(chunk)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => `${tag} ${line}`)
    .join("\n");

const mtime = (file) => {
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
const staleInstallReason = () => {
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
      `[dev] bun install --frozen-lockfile failed (${error.message}); dev cannot start without its dependencies. Fix the install and start dev again.`,
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
const cropsOf = (locale) =>
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
const newestFile = (path) => {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return undefined;
  }
  if (!stats.isDirectory()) return { file: path, mtimeMs: stats.mtimeMs };
  let newest;
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (SKIPPED_DIRS.has(entry.name)) continue;
    const found = newestFile(join(path, entry.name));
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  return newest;
};
const staleReason = () => {
  let rendered;
  for (const set of sets) {
    const marker = mtime(cropsOf(set));
    if (marker === undefined) return `no complete render of the ${set} set exists`;
    if (rendered === undefined || marker < rendered) rendered = marker;
  }
  let newest;
  for (const input of renderInputs) {
    const found = newestFile(input);
    if (found && (!newest || found.mtimeMs > newest.mtimeMs)) newest = found;
  }
  if (newest && newest.mtimeMs > rendered) {
    return `${relative(root, newest.file)} changed after the last render`;
  }
  return undefined;
};
const stale = staleReason();
if (stale === undefined) {
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
  const output = [];
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
  let spawnError;
  render.on("error", (error) => {
    spawnError = error;
  });
  const code = await new Promise((done) => render.on("close", done));
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

// Detached, so shutdown can signal the whole process group: `bun run dev` wraps the real `astro dev`
// process, and killing only the wrapper orphans astro, which then squats on port 5173 across sessions.
const web = spawn("bun", ["run", "dev"], {
  cwd: resolve(root, "apps/web"),
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let webKilled = false;
const killWeb = () => {
  // One-shot: the signal handler and WXT's exit handler both call this, and a second `astro dev stop`
  // would stall shutdown for up to 10 more seconds.
  if (webKilled) return;
  webKilled = true;
  // Astro 7 daemonizes `astro dev` when it detects an AI coding agent (am-i-vibing: CLAUDECODE, Copilot
  // terminals, Cursor, ...), so the real server may not be in the child's process group at all.
  //   daemonized astro               -> `astro dev stop`: reads Astro's lockfile, SIGTERM, then SIGKILL
  //                                     after 5s (its GRACEFUL_SHUTDOWN_TIMEOUT), so the timeout below
  //                                     must stay above that or the server can outlive the stop
  //   bun wrapper, foreground astro  -> the group kill below
  try {
    execFileSync("bunx", ["astro", "dev", "stop"], {
      cwd: resolve(root, "apps/web"),
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch {
    // No server running, or stop timed out; the group kill still applies.
  }
  // Negative pid: the wrapper's process group, which holds a foreground astro but not a daemonized one.
  try {
    process.kill(-web.pid, "SIGTERM");
  } catch {
    // Group already gone; nothing to clean up.
  }
};
web.stdout.on("data", (c) => console.log(prefixLines("[web]", c)));
web.stderr.on("data", (c) => console.error(prefixLines("[web]", c)));

// stdin is piped so the watchdog below can inject WXT's `o` (reopen) keypress; your own keystrokes are
// forwarded through, so interactive keys still work.
const wxt = spawn("bun", ["run", "dev"], {
  cwd: resolve(root, "apps/extension"),
  stdio: ["pipe", "inherit", "inherit"],
});
process.stdin.pipe(wxt.stdin, { end: false });

// WXT/web-ext never reopens the dev browser on its own: quitting Chrome (Cmd-Q), a crash, or a stray
// launch stealing the profile leaves dev running headless until someone types `o`. So on an
// alive -> gone transition of a Chrome holding the dev profile, press `o` for you.
const profileDir = resolve(root, "apps/extension/.wxt/chrome-data");
const browserAlive = () => {
  try {
    // execFile, no shell: the path must reach pgrep as ONE argument, never re-parsed by a shell.
    execFileSync("pgrep", ["-f", `user-data-dir=${profileDir}`], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
let wasAlive = false;
const watchdog = setInterval(() => {
  const alive = browserAlive();
  if (wasAlive && !alive && wxt.exitCode === null) {
    console.log("[dev] Dev browser closed, reopening...");
    wxt.stdin.write("o\n");
  }
  wasAlive = alive;
}, 3000);

const shutdown = () => {
  clearInterval(watchdog);
  killWeb();
  wxt.kill("SIGTERM");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

wxt.on("exit", (code) => {
  clearInterval(watchdog);
  killWeb();
  process.exit(code ?? 0);
});
web.on("exit", (code) => {
  if (code !== 0 && code !== null) console.error(`[web] exited with code ${code}`);
});
