import { NEVER_ABORTS } from "@/lib/slot";
import type { SynthesizeArgs } from "@/providers/types";

/** A complete SynthesizeArgs with neutral prosody and a signal that never
 *  aborts; tests override only the fields they are about. */
export function synthArgs(overrides: Partial<SynthesizeArgs> = {}): SynthesizeArgs {
  return {
    text: "Hello.",
    voiceId: "voice",
    model: "neural",
    encoding: "MP3",
    speed: 1,
    pitch: 0,
    volumeGainDb: 0,
    credentials: {},
    signal: NEVER_ABORTS,
    ...overrides,
  };
}
