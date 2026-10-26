// The command-line half of the check scripts under scripts/checks/. A scan that inspected nothing
// exits 1 too: a wrong scan root is a broken check, not a clean tree.

export interface ScanResult {
  /** Units the scan actually looked at (files, steps): zero fails the check. */
  inspected: number;

  /** One line per finding, printed behind an `x` marker as the check wrote it. */
  findings: string[];
}

export async function runCheck<T extends ScanResult>(check: {
  scan: () => T | Promise<T>;
  empty: string;
  failed: (count: number) => string;
  passed: (result: T) => string;
}): Promise<void> {
  const result = await check.scan();
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
