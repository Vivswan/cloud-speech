import { type StorageSource, useStorageValue } from "@/hooks/useStorageValue";
import { type Playback, readPlayback, watchPlayback } from "@/lib/playback";

const playbackSource: StorageSource<Playback> = { getValue: readPlayback, watch: watchPlayback };

/** Null until the first read has settled: controls must not act on a default the background never wrote. */
export function usePlayback(): Playback | null {
  return useStorageValue(playbackSource, null);
}
