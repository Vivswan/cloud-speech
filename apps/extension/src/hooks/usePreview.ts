import { type StorageSource, useStorageValue } from "@/hooks/useStorageValue";
import { readPreview, watchPreview } from "@/lib/playback";
import type { VoiceModelRef } from "@/lib/storage";

const previewSource: StorageSource<VoiceModelRef | null> = {
  getValue: readPreview,
  watch: watchPreview,
};

export function usePreview(): VoiceModelRef | null {
  return useStorageValue(previewSource, null);
}
