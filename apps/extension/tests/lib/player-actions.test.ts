import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";

vi.mock("@/lib/i18n-runtime", () => ({ i18n: { t: (key: string) => key } }));

import {
  clearBackgroundError,
  getBackgroundError,
  listenForBackgroundErrors,
  subscribeBackgroundError,
} from "@/lib/background-error";
import * as player from "@/lib/player-actions";
import type { VoiceModelRef } from "@/lib/storage";

type Reply = { ok: true; value?: unknown } | { ok: false; error: string };

/** A background that answers the given routes and leaves the rest unclaimed. */
function background(replies: Record<string, Reply>): string[] {
  const sent: string[] = [];
  fakeBrowser.runtime.onMessage.addListener(
    (message: unknown, _sender, sendResponse: (response?: unknown) => void) => {
      const { to, id } = message as { to?: string; id?: string };
      if (to !== "background" || !id) return;
      sent.push(id);
      const reply = replies[id];
      if (!reply) return;
      sendResponse(reply);
      return true;
    },
  );
  return sent;
}

const JOANNA: VoiceModelRef = { providerId: "polly", voiceId: "Joanna", model: "neural" };
const ARIA: VoiceModelRef = { providerId: "azure", voiceId: "Aria", model: "neural" };

describe("player actions", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    clearBackgroundError();
  });

  it("togglePreview sends the row as an intent; the background decides between start and stop", async () => {
    background({ previewVoice: { ok: true, value: true } });
    const seen: unknown[] = [];
    fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
      seen.push(message);
    });

    // Two immediate presses on one row: both reach the background as the same
    // intent (its slot turns the second into a stop); the popup never sends a
    // stop of its own from a view that may not have caught up.
    await Promise.all([
      player.togglePreview({ ...JOANNA, language: "en-US" }),
      player.togglePreview({ ...JOANNA, language: "en-US" }),
    ]);

    const envelope = {
      to: "background",
      id: "previewVoice",
      payload: { ...JOANNA, language: "en-US" },
    };
    expect(seen).toEqual([envelope, envelope]);
    expect(getBackgroundError()).toBeNull();
  });

  it.each([
    { start: "play", act: () => player.play("Hello") },
    { start: "togglePreview", act: () => player.togglePreview({ ...ARIA, language: "en-US" }) },
  ])("$start hides the previous failure; the next failure shows again", async ({ act }) => {
    background({
      readAloud: { ok: true, value: true },
      previewVoice: { ok: true, value: true },
    });
    const stop = listenForBackgroundErrors();
    try {
      const pushed = { title: "Speech synthesis failed", message: "Error: 401" };
      const push = () =>
        fakeBrowser.runtime.sendMessage({ to: "popup", id: "backgroundError", payload: pushed });
      const notified = vi.fn();
      subscribeBackgroundError(notified);

      await push();
      expect(getBackgroundError()).toEqual(pushed);

      // Cleared as the request goes out, before the reply: the banner must not
      // outlive the failed read once the retry is under way.
      let atSend: unknown = "unread";
      fakeBrowser.runtime.onMessage.addListener((message: unknown) => {
        const { to } = message as { to?: string };
        if (to === "background") atSend = getBackgroundError();
      });
      await act();
      expect(atSend).toBeNull();
      expect(getBackgroundError()).toBeNull();

      await push();
      expect(getBackgroundError()).toEqual(pushed);
      expect(notified).toHaveBeenCalledTimes(3);
    } finally {
      stop();
    }
  });

  it.each([true, false])(
    "seekTo reports the handler's verdict (%s) so the thumb can fall back",
    async (verdict) => {
      background({ playerSeekTo: { ok: true, value: verdict } });
      await expect(player.seekTo(5)).resolves.toBe(verdict);
    },
  );

  it("a handler that failed is not reported twice; a request nobody answered is", async () => {
    // The background surfaces its own handler failures (dispatcher onError).
    background({ playerPause: { ok: false, error: "Error: boom" } });
    await expect(player.pause()).resolves.toBeUndefined();
    expect(getBackgroundError()).toBeNull();

    // No background at all: the popup is the only one who can say so.
    const notified = vi.fn();
    subscribeBackgroundError(notified);
    await expect(player.resume()).resolves.toBeUndefined();
    // The shared notice shape: what to do in plain words, the raw text apart.
    expect(getBackgroundError()).toEqual({
      title: "errors.request_failed_title",
      message: "errors.request_failed_message",
      detail: "Error: background did not respond to playerResume",
    });
    expect(notified).toHaveBeenCalledTimes(1);
  });
});

describe("background error listener", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    clearBackgroundError();
  });

  it("receives pushed errors while at least one listener is registered, once each", async () => {
    const pushed = { title: "Speech synthesis failed", message: "Error: 401" };
    const push = () =>
      fakeBrowser.runtime.sendMessage({ to: "popup", id: "backgroundError", payload: pushed });
    const notified = vi.fn();
    subscribeBackgroundError(notified);

    const first = listenForBackgroundErrors();
    const second = listenForBackgroundErrors();
    await push();
    expect(getBackgroundError()).toEqual(pushed);
    expect(notified).toHaveBeenCalledTimes(1);

    clearBackgroundError();
    first();
    await push();
    expect(getBackgroundError()).toEqual(pushed);

    clearBackgroundError();
    second();
    await push().catch(() => {});
    expect(getBackgroundError()).toBeNull();
  });
});
