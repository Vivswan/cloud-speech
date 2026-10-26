import { i18n, type MessageKey } from "../text/i18n-runtime";

/** Nothing was asked of a provider, so the thrower states what its code
 *  observed as `detail` (developer-grade English, never localized, never a
 *  credential). Built from keys, not sentences, so it renders in the locale
 *  active when it shows and the classifier recognizes it by class instead of
 *  by comparing translated text. */
export class UserFacingError extends Error {
  /** Inherited, `name` would still read "Error"; set so a console line names the class. */
  override readonly name: string = "UserFacingError";

  /** Rendered only when the notice shows, in the locale active then. */
  readonly titleKey: MessageKey;

  /** Rendered at throw time too, as the Error's own message, so a console line reads the sentence. */
  readonly messageKey: MessageKey;

  /** The technical reason, for the collapsed Details. */
  readonly detail: string;

  /** The one link that fixes it, when there is one. */
  readonly action?: { labelKey: MessageKey; url: string };

  constructor(notice: {
    titleKey: MessageKey;
    messageKey: MessageKey;
    detail: string;
    action?: { labelKey: MessageKey; url: string };
  }) {
    // The Error message is the sentence itself, so a console line reads like
    // the notice did; the technical reason follows it.
    super(`${i18n.t(notice.messageKey)} (${notice.detail})`);
    this.titleKey = notice.titleKey;
    this.messageKey = notice.messageKey;
    this.detail = notice.detail;
    if (notice.action) this.action = notice.action;
  }
}
