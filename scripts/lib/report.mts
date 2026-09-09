// The command-line half shared by the repository scans under scripts/: run the
// scan only when bun invoked this very file (under Vitest argv[1] is the test
// worker, so an import never runs it), print findings as `x ...` lines, and
// exit 1 on any finding OR on a scan that inspected nothing (a wrong scan root
// is a broken check, not a clean tree).

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Whether bun ran the module at `moduleUrl` as the command-line entry, as
 *  opposed to importing it (from a test, or from another script). */
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
    /** Printed when the scan inspected nothing. */
    empty: string;
    /** Summary line under the findings; receives their count. */
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
