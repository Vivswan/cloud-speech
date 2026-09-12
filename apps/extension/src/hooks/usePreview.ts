import { useEffect, useState } from "react";
import { readPreview, watchPreview } from "@/lib/playback";
import type { VoiceModelRef } from "@/lib/storage";

export function usePreview(): VoiceModelRef | null {
  // Wrapped so a watched null ("the preview ended") is distinguishable from "not read yet": the
  // mount read may resolve with a row the watcher has already seen cleared, and the watched value must win.
  const [state, setState] = useState<{ preview: VoiceModelRef | null } | null>(null);

  useEffect(() => {
    const unwatch = watchPreview((preview) => setState({ preview }));
    void readPreview().then((initial) => setState((prev) => prev ?? { preview: initial }));
    return unwatch;
  }, []);

  return state?.preview ?? null;
}
