import { useCallback, useState } from "react";

export interface Report<T> {
  value: T;
  /** Unique per report across the popup, so two surfaces shown in one slot (an import failure and
   *  a refused write) never share one. */
  key: number;
}

let reports = 0;

/** A point in the report sequence, for `clearThrough` below: a report issued after it is newer than
 *  the mark whichever order the two landed in. */
export function reportMark(): number {
  return reports;
}

/** Every value set is a new report, one whose text matches the last (a second Save & test failing
 *  with the same HTTP 403) included, so a notice keyed on `key` starts with its Details collapsed again.
 *  `clearThrough(mark)` clears a report issued by that mark and keeps a newer one. */
export function useReport<T>(): [
  Report<T> | null,
  (value: T | null) => void,
  (mark: number) => void,
] {
  const [report, setReport] = useState<Report<T> | null>(null);
  const set = useCallback((value: T | null) => {
    if (value === null) {
      setReport(null);
      return;
    }
    reports += 1;
    setReport({ value, key: reports });
  }, []);
  const clearThrough = useCallback((mark: number) => {
    setReport((current) => (current && current.key > mark ? current : null));
  }, []);
  return [report, set, clearThrough];
}
