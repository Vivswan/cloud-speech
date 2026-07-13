import { getProvider } from "@/providers";
import { getSettings, type Settings, voicesSessionItem } from "./storage";
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
 * Callers that computed anything from settings (cache keys, issue keys) MUST
 * pass that same snapshot via `options.settings` so the synthesis parameters
 * can never diverge from what the caller believes them to be.
 */
export async function getAudioUri(options: {
  text: string;
  encoding: string;
  speed?: number;
  settings?: Settings;
}): Promise<string> {
  const settings = options.settings ?? (await getSettings());
  const selected = settings.selectedVoice;
  if (!selected) throw new NoVoiceSelectedError();
  if (!settings.enabledProviders[selected.providerId]) {
    throw new ProviderDisabledError(selected.providerId);
  }

  const provider = getProvider(selected.providerId);
  const credentials = settings.credentials[selected.providerId] ?? {};

  const cachedVoices = await voicesSessionItem.getValue();
  const voice = cachedVoices.find(
    (v) => v.providerId === selected.providerId && v.id === selected.voiceId,
  );

  // Clamp here, against the SAME provider/model the synthesis uses: callers
  // pass raw multiplied speeds (e.g. download bakes the live player rate in).
  const range = provider.ranges(settings.model).speed;
  const speed = Math.min(range.max, Math.max(range.min, options.speed ?? settings.speed));

  const result = await provider.synthesize({
    text: options.text,
    voiceId: selected.voiceId,
    model: settings.model,
    style: settings.style,
    language: voice?.languageCodes[0],
    encoding: options.encoding,
    speed,
    pitch: settings.pitch,
    volumeGainDb: settings.volumeGainDb,
    credentials,
  });

  return bytesToDataUri(result.bytes, result.extension);
}
