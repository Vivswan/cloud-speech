import { getProvider } from "@/providers";
import {
  credentialsFor,
  type EncodingPurpose,
  isProviderEnabled,
  resolveEncoding,
} from "./provider-state";
import { type Settings, voicesSessionItem } from "./storage";
import { bytesToDataUri } from "./tts";

// The messages state what the code observed: they are the technical detail
// of the notice the user reads (lib/errors.ts).
export class NoVoiceSelectedError extends Error {
  constructor() {
    super("settings.selection is null");
    this.name = "NoVoiceSelectedError";
  }
}

export class ProviderDisabledError extends Error {
  constructor(providerId: string) {
    super(`settings.perProvider.${providerId}.enabled is false`);
    this.name = "ProviderDisabledError";
  }
}

/** Synthesis with the selected voice (previews and scans hand their own voice
 *  to provider.synthesize), failing loudly here on a null selection or a
 *  disabled provider, never mid-playback. `settings` is the caller's
 *  snapshot, so cache and issue keys never diverge from the synthesis
 *  parameters. */
export async function getAudioUri(options: {
  text: string;
  purpose: EncodingPurpose;
  speed?: number;
  settings: Settings;
  signal: AbortSignal;
}): Promise<string> {
  const settings = options.settings;
  const selection = settings.selection;
  if (!selection) throw new NoVoiceSelectedError();
  if (!isProviderEnabled(settings, selection.providerId)) {
    throw new ProviderDisabledError(selection.providerId);
  }

  const provider = getProvider(selection.providerId);
  const credentials = credentialsFor(settings, selection.providerId);

  const cachedVoices = await voicesSessionItem.getValue();
  const voice = cachedVoices.find(
    (v) => v.providerId === selection.providerId && v.id === selection.voiceId,
  );

  // Clamp against the SAME provider/model the synthesis uses: callers pass raw
  // multiplied speeds (download bakes the live player rate in).
  const range = provider.ranges(selection.model).speed;
  const speed = Math.min(range.max, Math.max(range.min, options.speed ?? settings.speed));

  const result = await provider.synthesize({
    text: options.text,
    voiceId: selection.voiceId,
    model: selection.model,
    style: selection.style,
    language: voice?.languageCodes[0],
    encoding: resolveEncoding(settings, provider, options.purpose),
    speed,
    pitch: settings.pitch,
    volumeGainDb: settings.volumeGainDb,
    credentials,
    signal: options.signal,
  });

  return bytesToDataUri(result.bytes, result.extension);
}
