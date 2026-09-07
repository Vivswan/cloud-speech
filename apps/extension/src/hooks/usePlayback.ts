import { useEffect, useState } from "react";
import { type Playback, readPlayback, watchPlayback } from "@/lib/playback";

/** The background's playback document, live. Null until the first read has
 *  settled: controls must not act on a default the background never wrote. */
export function usePlayback(): Playback | null {
  const [playback, setPlayback] = useState<Playback | null>(null);

  useEffect(() => {
    // Watch before read: a change landing between the read and the subscribe
    // would otherwise be lost, and a change that beat the read is newer.
    const unwatch = watchPlayback(setPlayback);
    void readPlayback().then((initial) => setPlayback((prev) => prev ?? initial));
    return unwatch;
  }, []);

  return playback;
}
