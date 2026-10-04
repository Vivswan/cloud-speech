import { useEffect, useState } from "react";

/** The read-and-watch pair a WXT storage item already has; a derived value (a decoded record,
 *  a parsed document) supplies the same two functions. */
export interface StorageSource<T> {
  getValue(): Promise<T>;
  watch(callback: (value: T) => void): () => void;
}

/**
 * The current value of a storage item, `beforeRead` until either the first read or a watched
 * change delivers one.
 *
 * Watch before read: a change that lands while the read is in flight is newer than what the read
 * captured, so the read never overwrites it. The value is boxed so a stored null (a preview that
 * ended) stays distinguishable from "nothing delivered yet". `source` is an effect dependency: a
 * module-level constant subscribes once, an inline literal re-subscribes on every render.
 */
export function useStorageValue<T, U = T>(source: StorageSource<T>, beforeRead: U): T | U {
  const [state, setState] = useState<{ value: T } | null>(null);

  useEffect(() => {
    const unwatch = source.watch((value) => setState({ value }));
    void source.getValue().then((initial) => setState((prev) => prev ?? { value: initial }));
    return unwatch;
  }, [source]);

  return state ? state.value : beforeRead;
}
