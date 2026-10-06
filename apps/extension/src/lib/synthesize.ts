import { getProvider } from "@/providers";
import { UserFacingError } from "./errors/user-facing-error";
import {
  credentialsFor,
  type EncodingPurpose,
  isProviderEnabled,
  resolveEncoding,
} from "./settings/provider-state";
import { type Settings, voicesSessionItem } from "./settings/storage";
import type { MessageKey } from "./text/i18n-runtime";
import { bytesToDataUri } from "./tts";

/** The sentence depends on where the user reads it: the page toast sends them
 *  into the popup, while the sandbox is already inside it. */
export class NoVoiceSelectedError extends UserFacingError {
  override readonly name = "NoVoiceSelectedError";

  constructor(messageKey: MessageKey = "errors.no_voice_message") {
    super({
      titleKey: "errors.no_voice_title",
      messageKey,
      detail: "NoVoiceSelectedError: settings.selection is null",
    });
  }
}

export class ProviderDisabledError extends UserFacingError {
  override readonly name = "ProviderDisabledError";

  constructor(providerId: string) {
    super({
      titleKey: "errors.provider_disabled_title",
      messageKey: "errors.provider_disabled_message",
      detail: `ProviderDisabledError: settings.perProvider.${providerId}.enabled is false`,
    });
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
