import { i18n, type MessageKey } from "./i18n-runtime";

/** A failure the extension explains on its own: nothing was asked of a
 *  provider, so there is no status or body to keep as detail, only the
 *  sentence the user reads. The notice is built from keys, not sentences,
 *  so it renders in the locale active when it shows, and the classifier
 *  recognizes it by class instead of by comparing translated text. */
export class UserFacingError extends Error {
  override readonly name = "UserFacingError";
  readonly titleKey: MessageKey;
  readonly messageKey: MessageKey;
  /** The one link that fixes it, when there is one. */
  readonly action?: { labelKey: MessageKey; url: string };

  constructor(notice: {
    titleKey: MessageKey;
    messageKey: MessageKey;
    action?: { labelKey: MessageKey; url: string };
  }) {
    // The Error message is the sentence itself, so a console line reads like
    // the notice did.
    super(i18n.t(notice.messageKey));
    this.titleKey = notice.titleKey;
    this.messageKey = notice.messageKey;
    if (notice.action) this.action = notice.action;
  }
}
