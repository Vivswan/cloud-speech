import { useEffect, useState } from "react";
import { readPreview, type VoiceRef, watchPreview } from "@/lib/playback";

/** The voice row the background is auditioning right now, or null. */
export function usePreview(): VoiceRef | null {
  // Wrapped so that a watched null ("the preview ended") is distinguishable
  // from "not read yet": the mount read may resolve with a row the watcher
  // has already seen cleared, and the watched value must win.
  const [state, setState] = useState<{ preview: VoiceRef | null } | null>(null);

  useEffect(() => {
    const unwatch = watchPreview((preview) => setState({ preview }));
    void readPreview().then((initial) => setState((prev) => prev ?? { preview: initial }));
    return unwatch;
  }, []);

  return state?.preview ?? null;
}
