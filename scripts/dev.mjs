#!/usr/bin/env node
// Dev orchestrator: runs the website (Vite) in the background and the
// extension (WXT) in the FOREGROUND with the real terminal attached.
//
// Why not `bun run --filter '*' dev`? The filter runner closes each child's
// stdin — WXT's interactive key listener hits EOF and exits ~5s after launch,
// closing the dev browser with it. WXT needs a live stdin.

import { execSync, spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Website: background, output prefixed.
const web = spawn("bun", ["run", "dev"], {
  cwd: resolve(root, "apps/web"),
  stdio: ["ignore", "pipe", "pipe"],
});
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

// Browser watchdog: WXT/web-ext never reopens the dev browser on its own —
// quitting Chrome (⌘Q), a crash, or a stray launch stealing the profile just
// leaves dev running headless until someone types `o`. Poll for a Chrome
// holding the dev profile and, on an alive→gone transition, press `o` for you.
const profileDir = resolve(root, "apps/extension/.wxt/chrome-data");
const browserAlive = () => {
  try {
    execSync(`pgrep -f "user-data-dir=${profileDir}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};
let wasAlive = false;
const watchdog = setInterval(() => {
  const alive = browserAlive();
  if (wasAlive && !alive && wxt.exitCode === null) {
    console.log("[dev] Dev browser closed — reopening…");
    wxt.stdin.write("o\n");
  }
  wasAlive = alive;
}, 3000);

const shutdown = () => {
  clearInterval(watchdog);
  web.kill("SIGTERM");
  wxt.kill("SIGTERM");
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

wxt.on("exit", (code) => {
  clearInterval(watchdog);
  web.kill("SIGTERM");
  process.exit(code ?? 0);
});
web.on("exit", (code) => {
  if (code !== 0 && code !== null) console.error(`[web] exited with code ${code}`);
});
