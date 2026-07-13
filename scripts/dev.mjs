#!/usr/bin/env node
// Dev orchestrator: runs the website (Vite) in the background and the
// extension (WXT) in the FOREGROUND with the real terminal attached.
//
// Why not `bun run --filter '*' dev`? The filter runner closes each child's
// stdin; WXT's interactive key listener hits EOF and exits ~5s after launch,
// closing the dev browser with it. WXT needs a live stdin.

import { execFileSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
const prefix = (chunk) =>
  String(chunk)
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => `[web] ${line}`)
    .join("\n");
web.stdout.on("data", (c) => console.log(prefix(c)));
web.stderr.on("data", (c) => console.error(prefix(c)));

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
    console.log("[dev] Dev browser closed, reopening…");
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
