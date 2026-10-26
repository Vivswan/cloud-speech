// A valid MPEG-1 Layer III stream of silence, built frame by frame so the e2e suite needs no audio fixture and no encoder.
// Each frame is the 4-byte header, 17 bytes of zeroed mono side info and no main data; all-zero side info decodes as silence.

// Must agree with the header's sample-rate bits below.
const SAMPLE_RATE = 44_100;

// Fixed by MPEG-1 Layer III.
const SAMPLES_PER_FRAME = 1152;

// Must agree with the header's bitrate bits below.
const BITRATE = 32_000;

// The standard's frame-size formula; no +1 since the header's padding bit is clear.
const FRAME_BYTES = Math.floor((144 * BITRATE) / SAMPLE_RATE);

// Sync (11 bits), MPEG-1, Layer III, no CRC | 32 kbps, 44.1 kHz, no padding | mono, no emphasis.
const FRAME_HEADER = Uint8Array.of(0xff, 0xfb, 0x10, 0xc0);

// About 26 ms (1152 samples at 44.1 kHz), the step a requested duration is rounded up by.
const MP3_FRAME_SECONDS = SAMPLES_PER_FRAME / SAMPLE_RATE;

/** Silence lasting at least `seconds` (rounded up to whole frames). */
export function silentMp3(seconds: number): Uint8Array {
  const frames = Math.ceil(seconds / MP3_FRAME_SECONDS);
  const bytes = new Uint8Array(frames * FRAME_BYTES);
  for (let frame = 0; frame < frames; frame++) {
    bytes.set(FRAME_HEADER, frame * FRAME_BYTES);
  }
  return bytes;
}
