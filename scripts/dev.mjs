#!/usr/bin/env node
// Dev orchestrator: runs the website (Vite) in the background and the
// extension (WXT) in the FOREGROUND with the real terminal attached.
//
// Why not `bun run --filter '*' dev`? The filter runner closes each child's
// stdin; WXT's interactive key listener hits EOF and exits ~5s after launch,
// closing the dev browser with it. WXT needs a live stdin.

import { execFileSync, spawn } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const prefixLines = (tag, chunk) =>
  String(chunk)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => `${tag} ${line}`)
    .join("\n");

// Store screenshots: production serves the set CI publishes; dev renders it
// here when it is missing or older than anything the render is made from, and
// the website's dev server serves it to the walkthrough page
// (docs/store-listing.md). A render that fails leaves dev usable: the page
// shows the published set until a local render exists.
//
// crops.json is the renderer's completion marker: it removes the file before
// its first scene and writes it last, so its mtime is the render's time.
const crops = resolve(root, "apps/extension/.output/store-screenshots/crops.json");
// What a render is made from: the extension source the scenes capture (its
// locales included), the workspace packages it imports (the shared palette and
// constants), the renderer with the e2e modules it imports, and the build
// configuration and dependencies that decide what the source compiles to (an
// icon library bump redraws every icon without touching a source file).
const renderInputs = [
  "apps/extension/src",
  "packages",
  "apps/extension/e2e/store-screenshots.ts",
  "apps/extension/e2e/fixtures.ts",
  "apps/extension/e2e/playback-waits.ts",
  "apps/extension/e2e/fake-provider",
  "apps/extension/package.json",
  "apps/extension/wxt.config.ts",
  "apps/extension/tsconfig.json",
  "bun.lock",
].map((path) => resolve(root, path));
const SKIPPED_DIRS = new Set(["node_modules", ".output", ".wxt"]);
const mtime = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};
/** The newest file under `path` (or `path` itself), as `{ file, mtimeMs }`;
 *  undefined when nothing is there. */
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
/** Why the render is stale, or undefined when it is current. */
const staleReason = () => {
  const rendered = mtime(crops);
  if (rendered === undefined) return "no complete render exists";
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
    "[dev] Store screenshots are current (apps/extension/.output/store-screenshots); not rendering.",
  );
} else {
  console.log(
    `[dev] Rendering the store screenshots for the walkthrough page (${stale}): bun run screenshots:store...`,
  );
  // The renderer removes the marker itself, but only once Playwright reaches
  // its setup; a failure before that (the extension build, say) would leave
  // the old marker and dev serving the stale set as if it were current.
  rmSync(crops, { force: true });
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
  // A spawn failure (no `bun` on the child's PATH, say) emits `error` instead
  // of `exit`; unhandled, it would end dev here. `close` follows both.
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

// Website: background, output prefixed. Detached puts it in its own process
// group so shutdown can signal the WHOLE tree: `bun run dev` wraps the real
// `astro dev` process, and killing just the wrapper's pid orphans astro,
// which then squats on port 5173 across sessions.
const web = spawn("bun", ["run", "dev"], {
  cwd: resolve(root, "apps/web"),
  stdio: ["ignore", "pipe", "pipe"],
  detached: true,
});
let webKilled = false;
const killWeb = () => {
  // One-shot: the signal handler and WXT's exit handler both call this, and
  // a second `astro dev stop` would stall shutdown for up to 10 more seconds.
  if (webKilled) return;
  webKilled = true;
  // Astro 7 daemonizes `astro dev` whenever it detects an AI coding agent
  // (am-i-vibing: CLAUDECODE, Copilot terminals, Cursor, ...), so the real
  // server may not be in the child's process group at all. `astro dev stop`
  // reads Astro's lockfile and stops either flavor (SIGTERM, then SIGKILL
  // after 5s). The group kill below still reaps the bun wrapper and a
  // plain foreground astro.
  try {
    execFileSync("bunx", ["astro", "dev", "stop"], {
      cwd: resolve(root, "apps/web"),
      stdio: "ignore",
      timeout: 10_000,
    });
  } catch {
    // No server running, or stop timed out; the group kill still applies.
  }
  // Negative pid = signal the process group (wrapper AND astro).
  try {
    process.kill(-web.pid, "SIGTERM");
  } catch {
    // Group already gone; nothing to clean up.
  }
};
web.stdout.on("data", (c) => console.log(prefixLines("[web]", c)));
web.stderr.on("data", (c) => console.error(prefixLines("[web]", c)));

// Extension: foreground with the real terminal for output; stdin is piped so
// the browser watchdog below can inject WXT's `o` (reopen) keypress. Your own
// keystrokes are forwarded through, so interactive keys still work.
const wxt = spawn("bun", ["run", "dev"], {
  cwd: resolve(root, "apps/extension"),
  stdio: ["pipe", "inherit", "inherit"],
});
process.stdin.pipe(wxt.stdin, { end: false });

// Browser watchdog: WXT/web-ext never reopens the dev browser on its own.
// Quitting Chrome (⌘Q), a crash, or a stray launch stealing the profile just
// leaves dev running headless until someone types `o`. Poll for a Chrome
// holding the dev profile and, on an alive→gone transition, press `o` for you.
const profileDir = resolve(root, "apps/extension/.wxt/chrome-data");
const browserAlive = () => {
  try {
    // execFile (no shell): the path must reach pgrep as ONE argument, never
    // be re-parsed by a shell.
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
