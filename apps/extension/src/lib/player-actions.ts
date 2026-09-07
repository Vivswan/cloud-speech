import { reportBackgroundError } from "./background-error";
import { i18n } from "./i18n-runtime";
import { sameVoiceRef, type VoiceRef } from "./playback";
import {
  FailureReplyError,
  type PayloadArgs,
  type Result,
  type RouteId,
  sendToBackground,
} from "./protocol";

// ---------------------------------------------------------------------------
// The popup's player controls, as plain functions over background requests.
// State is not mirrored here: the controls watch the playback and preview
// documents (hooks/usePlayback.ts, hooks/usePreview.ts) and these calls only
// ask the background to move them.
// ---------------------------------------------------------------------------

/** One background request from a control. A failure reply was seen by the
 *  background, which surfaces handler failures itself; a request that never
 *  got an answer (dead worker, timeout, malformed reply) is reported here, so
 *  no control needs a catch of its own. Resolves undefined on any failure. */
async function request<K extends RouteId<"background">>(
  id: K,
  ...args: PayloadArgs<"background", K>
): Promise<Result<"background", K> | undefined> {
  try {
    return await sendToBackground(id, ...args);
  } catch (error) {
    if (!(error instanceof FailureReplyError)) {
      reportBackgroundError({
        title: i18n.t("errors.request_failed_title"),
        message: String(error),
      });
    }
    return undefined;
  }
}

export function play(text: string, speed?: number): Promise<unknown> {
  return request("readAloud", { text, speed });
}

export function pause(): Promise<unknown> {
  return request("playerPause");
}

export function resume(): Promise<unknown> {
  return request("playerResume");
}

/** True when the session committed the position; false when nothing could be
 *  seeked (the thumb then falls back to the document's position). */
export async function seekTo(seconds: number): Promise<boolean> {
  return (await request("playerSeekTo", { seconds })) === true;
}

export function setRate(rate: number): Promise<unknown> {
  return request("playerSetRate", { rate });
}

/** The row's audition button toggles: pressing the row already auditioning
 *  stops it, any other row starts (and thereby replaces) the preview. */
export function togglePreview(
  auditioning: VoiceRef | null,
  target: VoiceRef & { language?: string },
): Promise<unknown> {
  return auditioning && sameVoiceRef(auditioning, target)
    ? request("stopPreview")
    : request("previewVoice", target);
}
