import { type ExtensionSession, type LaunchOptions, launchExtensionOn } from "./fixtures";

/** Close the browser but keep its profile, then start the extension again on
 *  that profile: what the user's browser does after an update lands. The
 *  extension's startup runs afresh against whatever the profile holds. The
 *  profile passes to the returned session, whose close() removes it; the given
 *  session is finished and must not be closed. Whichever step fails removes
 *  the profile, so none is left behind. */
export async function relaunchExtension(
  session: ExtensionSession,
  options?: LaunchOptions,
): Promise<ExtensionSession> {
  try {
    await session.context.close();
  } catch (error) {
    await session.close();
    throw error;
  }
  return launchExtensionOn(session.userDataDir, options);
}
