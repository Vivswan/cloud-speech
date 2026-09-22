// The one file walker behind the check scripts: which directories a scan never enters is decided here,
// once. A directory that cannot be read throws rather than vanishing from the scan, so an unreadable
// subtree can never pass a check as clean.

import { sep } from "node:path";
import { type FSLike, fdir } from "fdir";

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
  /** The filesystem the crawl reads; tests hand in their own. */
  readonly fs?: FSLike;
}

/** Absolute paths, sorted so output never depends on the filesystem's listing order. Symlinked directories
 *  are walked and symlinked files kept, both under the link's own path. */
export function walk(dir: string, options: WalkOptions): string[] {
  // fdir hands `exclude` the directory path with a trailing separator.
  const excluded = new Set(
    (options.exclude ?? []).map((path) => (path.endsWith(sep) ? path : path + sep)),
  );
  return new fdir({ fs: options.fs })
    .withFullPaths()
    .withErrors()
    .withSymlinks({ resolvePaths: false })
    .exclude((name, path) => SKIP_DIRS.has(name) || excluded.has(path))
    .filter((path) => options.extensions.some((extension) => path.endsWith(extension)))
    .crawl(dir)
    .sync()
    .sort();
}
