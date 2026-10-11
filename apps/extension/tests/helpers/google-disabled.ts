/** A Google 403 for a voice whose API is switched off, hand-written in the
 *  shape of the live response, with an invented project number. */
export const FAKE_GOOGLE_PROJECT = "123456789012";

export const GOOGLE_CONSOLE_URL = `https://console.developers.google.com/apis/api/aiplatform.googleapis.com/overview?project=${FAKE_GOOGLE_PROJECT}`;

export const GOOGLE_DISABLED_DETAIL =
  `Agent Platform API has not been used in project ${FAKE_GOOGLE_PROJECT} before or it is disabled. ` +
  `Enable it by visiting ${GOOGLE_CONSOLE_URL} then retry. ` +
  "If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.";
