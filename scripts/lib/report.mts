// The command-line half of the check scripts under scripts/. A scan that inspected nothing exits 1 too:
// a wrong scan root is a broken check, not a clean tree.

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Under Vitest argv[1] is the test worker, so an import from a test never runs the scan. */
export function invokedDirectly(moduleUrl: string): boolean {
  const entry = process.argv[1];
  // fileURLToPath rejects non-file URLs, and such a module is never the entry.
  if (entry === undefined || !moduleUrl.startsWith("file:")) return false;
  return resolve(entry) === fileURLToPath(moduleUrl);
}

export interface ScanResult {
  /** Units the scan actually looked at (files, steps): zero fails the check. */
  inspected: number;
  findings: string[];
}

export function runCheck<T extends ScanResult>(
  moduleUrl: string,
  check: {
    scan: () => T;
    empty: string;
    failed: (count: number) => string;
    passed: (result: T) => string;
  },
): void {
  if (!invokedDirectly(moduleUrl)) return;
  const result = check.scan();
  if (result.inspected === 0) {
    console.error(`x ${check.empty}`);
    process.exit(1);
  }
  if (result.findings.length > 0) {
    for (const finding of result.findings) console.error(`x ${finding}`);
    console.error(`\n${check.failed(result.findings.length)}`);
    process.exit(1);
  }
  console.log(check.passed(result));
}
