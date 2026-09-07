import { getProvider } from "@/providers";
import {
  credentialsFor,
  type EncodingPurpose,
  isProviderEnabled,
  resolveEncoding,
} from "./provider-state";
import { type Settings, voicesSessionItem } from "./storage";
import { bytesToDataUri } from "./tts";

export class NoVoiceSelectedError extends Error {
  constructor() {
    super("No voice selected");
    this.name = "NoVoiceSelectedError";
  }
}

export class ProviderDisabledError extends Error {
  constructor(providerId: string) {
    super(`Provider ${providerId} is disabled`);
    this.name = "ProviderDisabledError";
  }
}

/**
 * Synthesize `text` with the currently selected voice and return a playable
 * `data:` URI. Dispatches to the provider registry; this is the ONLY place
 * that routes synthesis, and it validates the selection defensively: a null
 * selection or a disabled provider must fail loudly here, never mid-playback.
 *
 * `settings` is the caller's snapshot so cache/issue keys never diverge from
 * the synthesis parameters; the format follows from it and `purpose`.
 */
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

  // Clamp here, against the SAME provider/model the synthesis uses: callers
  // pass raw multiplied speeds (e.g. download bakes the live player rate in).
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
