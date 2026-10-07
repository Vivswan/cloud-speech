// The one picker for the store zips: wxt.config.ts writes the filename pattern, and the scripts know
// only the version and the browser suffix of the zip they want.

import { readdirSync } from "node:fs";

export type StoreZipPick = string | { found: string[]; problem: string };

/** Several matches are refused rather than resolved: a stray copy of this version's zip would otherwise
 *  be handed on as the build. */
export function pickStoreZip(outDir: string, version: string, suffix: string): StoreZipPick {
  const wanted = `-${version}${suffix}`;
  let entries: string[];
  try {
    entries = readdirSync(outDir);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    return { found: [], problem: `${outDir} is missing; run the store builds first` };
  }
  const found = entries.filter((name) => name.endsWith(wanted));
  const [name] = found;
  if (found.length === 1 && name !== undefined) return name;
  return { found, problem: `expected exactly one *${wanted} in ${outDir}, found ${found.length}` };
}
