import { useCallback, useState } from "react";

/** A value with the identity of the report that produced it. */
export interface Report<T> {
  value: T;
  /** Unique per report across the popup, so two surfaces shown in one slot
   *  (an import failure and a refused write) never share one. */
  key: number;
}

let reports = 0;

/** State for a failure an inline notice shows. Every value set is a new
 *  report, one whose text matches the last (a second Save & test failing
 *  with the same HTTP 403) included, so the notice keyed on `key` starts
 *  with its Details collapsed again. Setting null clears the report. The
 *  setter's identity is stable, like useState's. */
export function useReport<T>(): [Report<T> | null, (value: T | null) => void] {
  const [report, setReport] = useState<Report<T> | null>(null);
  const set = useCallback((value: T | null) => {
    if (value === null) {
      setReport(null);
      return;
    }
    reports += 1;
    setReport({ value, key: reports });
  }, []);
  return [report, set];
}
