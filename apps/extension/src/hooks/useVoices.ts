import { useEffect, useState } from "react";
import { voicesSessionItem } from "@/lib/storage";
import type { NormalizedVoice } from "@/providers/types";

/** Reactive merged voice cache (session storage, all configured providers). */
export function useVoices(): NormalizedVoice[] {
  const [voices, setVoices] = useState<NormalizedVoice[]>([]);

  useEffect(() => {
    let mounted = true;
    voicesSessionItem.getValue().then((v) => mounted && setVoices(v));
    const unwatch = voicesSessionItem.watch((v) => mounted && setVoices(v ?? []));
    return () => {
      mounted = false;
      unwatch();
    };
  }, []);

  return voices;
}
