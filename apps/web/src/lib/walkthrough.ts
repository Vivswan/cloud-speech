import type { ScreenshotScene } from "@cloud-speech/store-screenshots";

export const WALKTHROUGH_STEPS = [
  { id: "select", scene: "01-context-menu" },
  { id: "listen", scene: "06-sandbox-reading-page" },
  { id: "voice", scene: "02-preferences-voice-picker" },
  { id: "tune", scene: "07-preferences-prosody" },
  { id: "formats", scene: "10-preferences-shortcuts" },
  { id: "connect", scene: "03-settings-providers" },
  { id: "error", scene: "09-settings-save-test-error" },
  { id: "sync", scene: "08-settings-sync" },
  { id: "sandbox", scene: "04-sandbox-player" },
  { id: "dark", scene: "05-preferences-dark" },
] as const satisfies readonly { id: string; scene: ScreenshotScene }[];

export type WalkthroughStepId = (typeof WALKTHROUGH_STEPS)[number]["id"];

export interface WalkthroughStepStrings {
  title: string;
  /** Rendered with set:html, so inline markup is allowed. */
  body: string;
  alt: string;
}

export type WalkthroughStrings = Record<WalkthroughStepId, WalkthroughStepStrings>;

export interface WalkthroughStep extends WalkthroughStepStrings {
  id: WalkthroughStepId;
  scene: ScreenshotScene;
}

export function walkthroughSteps(strings: WalkthroughStrings): WalkthroughStep[] {
  return WALKTHROUGH_STEPS.map((step) => ({ ...step, ...strings[step.id] }));
}
