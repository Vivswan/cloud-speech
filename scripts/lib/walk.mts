// The one file walker behind the check scripts: which directories a scan never enters is decided here,
// once.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** `sources` is the read-only reference forks; the rest are VCS, installs, build output, and caches. */
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
  readonly extensions: readonly string[];
  /** Absolute directory paths left out on top of SKIP_DIRS. */
  readonly exclude?: readonly string[];
}

/** Sorted, so output never depends on the filesystem. statSync follows symlinks: a linked directory is
 *  walked, a linked file kept. */
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
