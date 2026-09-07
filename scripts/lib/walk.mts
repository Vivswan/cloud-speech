// The one file walker behind the repo's check scripts: which directories a
// scan never enters is decided here, once.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directory names no check scans: VCS, installs, build output, caches, and
 *  the read-only reference forks. */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  ".git",
  ".output",
  ".wxt",
  ".astro",
  "dist",
  "coverage",
  "sources",
  ".claude",
]);

export interface WalkOptions {
  /** File name suffixes to keep, e.g. `[".yml", ".yaml"]`. */
  readonly extensions: readonly string[];
  /** Absolute directory paths left out on top of SKIP_DIRS. */
  readonly exclude?: readonly string[];
}

/** Every file under `dir` (recursively) whose name ends in one of the
 *  extensions, in a sorted order so output never depends on the filesystem.
 *  Symlinks are followed: a linked directory is walked, a linked file kept. */
export function* walk(dir: string, options: WalkOptions): Generator<string> {
  const { extensions } = options;
  const excluded = new Set(options.exclude ?? []);
  function* descend(current: string): Generator<string> {
    for (const entry of readdirSync(current).sort()) {
      const path = join(current, entry);
      if (statSync(path).isDirectory()) {
        if (!SKIP_DIRS.has(entry) && !excluded.has(path)) yield* descend(path);
      } else if (extensions.some((extension) => entry.endsWith(extension))) {
        yield path;
      }
    }
  }
  yield* descend(dir);
}
