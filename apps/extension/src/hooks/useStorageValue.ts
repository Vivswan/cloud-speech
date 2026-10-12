import { useEffect, useState } from "react";
import { logWarning } from "@/lib/errors/log";

/** The read-and-watch pair a WXT storage item already has; a derived value (a decoded record,
 *  a parsed document) supplies the same two functions. */
export interface StorageSource<T> {
  getValue(): Promise<T>;
  watch(callback: (value: T) => void): () => void;
}

function warnReadFailure(error: unknown): void {
  logWarning("Reading a storage item failed", error);
}

/**
 * The current value of a storage item, `beforeRead` until the first read or a watched change
 * delivers one.
 *
 * Watch before read: a change that lands while the read is in flight is newer than what the read
 * captured, so the read never overwrites it. The value is boxed so a stored null (a preview that
 * ended) stays distinguishable from "nothing delivered yet". `source` is the effect dependency: a
 * module-level constant subscribes once, an inline literal every render.
 */
export function useStorageValue<T, U = T>(source: StorageSource<T>, beforeRead: U): T | U {
  const [state, setState] = useState<{ value: T } | null>(null);

  useEffect(() => {
    // A watched change or an unmount makes the read's answer obsolete, failure included: the
    // same rule watchSettingsRecord (lib/settings/storage) applies to the settings record.
    let obsolete = false;
    const unwatch = source.watch((value) => {
      obsolete = true;
      setState({ value });
    });
    source.getValue().then(
      (initial) => setState((prev) => prev ?? { value: initial }),
      (error) => {
        if (!obsolete) warnReadFailure(error);
      },
    );
    return () => {
      obsolete = true;
      unwatch();
    };
  }, [source]);

  return state ? state.value : beforeRead;
}
