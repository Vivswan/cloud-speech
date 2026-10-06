import { useStorageValue } from "@/hooks/useStorageValue";
import { voicesSessionItem } from "@/lib/settings/storage";
import type { NormalizedVoice } from "@/providers/types";

const NO_VOICES: NormalizedVoice[] = [];

export function useVoices(): NormalizedVoice[] {
  return useStorageValue(voicesSessionItem, NO_VOICES);
}
