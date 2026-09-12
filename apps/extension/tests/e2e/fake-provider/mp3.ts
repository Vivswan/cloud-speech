// A valid MPEG-1 Layer III stream of silence, built frame by frame so the e2e suite needs no audio fixture and no encoder.
// Each frame is the 4-byte header, 17 bytes of zeroed mono side info and no main data; all-zero side info decodes as silence.

const SAMPLE_RATE = 44_100;
const SAMPLES_PER_FRAME = 1152;
const BITRATE = 32_000;
const FRAME_BYTES = Math.floor((144 * BITRATE) / SAMPLE_RATE);

// Sync (11 bits), MPEG-1, Layer III, no CRC | 32 kbps, 44.1 kHz, no padding | mono, no emphasis.
const FRAME_HEADER = Uint8Array.of(0xff, 0xfb, 0x10, 0xc0);

export const MP3_FRAME_SECONDS = SAMPLES_PER_FRAME / SAMPLE_RATE;

/** Silence lasting at least `seconds` (rounded up to whole frames). */
export function silentMp3(seconds: number): Uint8Array {
  const frames = Math.ceil(seconds / MP3_FRAME_SECONDS);
  const bytes = new Uint8Array(frames * FRAME_BYTES);
  for (let frame = 0; frame < frames; frame++) {
    bytes.set(FRAME_HEADER, frame * FRAME_BYTES);
  }
  return bytes;
}
