import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing";
import { usePlayerStore } from "@/stores/player";

// Drift guards for popup preview state. NO fakeBrowser.reset() here: the
// store registered its broadcast listener when this file imported it, and a
// reset would silently detach it; per-test listeners are removed instead.

const KEY_A = "polly:Joanna:neural";
const KEY_B = "azure:Aria:neural";

type Listener = (message: unknown) => undefined | Promise<unknown>;
const added: Listener[] = [];
function listen(fn: Listener): void {
  fakeBrowser.runtime.onMessage.addListener(fn);
  added.push(fn);
}

function sendBroadcast(id: string, payload: unknown): Promise<unknown> {
  return fakeBrowser.runtime.sendMessage({ id, payload }).catch(() => {});
}

describe("player store preview state", () => {
  beforeEach(() => {
    usePlayerStore.setState({
      status: "idle",
      rate: 1,
      textDigest: null,
      currentTime: 0,
      duration: 0,
      previewingKey: null,
      lastError: null,
      hydrated: false,
    });
  });

  afterEach(() => {
    for (const fn of added.splice(0)) {
      fakeBrowser.runtime.onMessage.removeListener(fn);
    }
  });

  it("hydrates previewingKey from playerGetState and stop-toggles that row", async () => {
    const sent: string[] = [];
    listen((message) => {
      const id = (message as { id?: string })?.id ?? "";
      sent.push(id);
      if (id === "playerGetState") {
        return Promise.resolve({
          status: "idle",
          rate: 1,
          textDigest: null,
          currentTime: 0,
          duration: 0,
          previewingKey: KEY_A,
        });
      }
      if (id === "stopPreview" || id === "previewVoice") return Promise.resolve(true);
    });

    await usePlayerStore.getState().refresh();
    expect(usePlayerStore.getState().hydrated).toBe(true);
    expect(usePlayerStore.getState().previewingKey).toBe(KEY_A);

    await usePlayerStore.getState().preview(KEY_A, {
      providerId: "polly",
      voiceId: "Joanna",
      model: "neural",
    });

    expect(sent).toContain("stopPreview");
    expect(sent).not.toContain("previewVoice");
    expect(usePlayerStore.getState().previewingKey).toBeNull();
  });

  it("previewEnded for another key leaves the current row untouched", async () => {
    usePlayerStore.setState({ previewingKey: KEY_B });

    // An older preview settling must not clear the newer row the user sees.
    await sendBroadcast("previewEnded", { key: KEY_A });
    expect(usePlayerStore.getState().previewingKey).toBe(KEY_B);

    await sendBroadcast("previewEnded", { key: KEY_B });
    expect(usePlayerStore.getState().previewingKey).toBeNull();
  });

  it("a refresh begun before previewEnded cannot resurrect the ended preview", async () => {
    let respond: (state: unknown) => void = () => {};
    listen((message) => {
      if ((message as { id?: string })?.id === "playerGetState") {
        return new Promise((resolve) => {
          respond = resolve;
        });
      }
    });

    const refreshing = usePlayerStore.getState().refresh();
    // The preview settles while the snapshot is still in flight; the snapshot
    // (taken earlier) still carries its key.
    await sendBroadcast("previewEnded", { key: KEY_A });
    respond({
      status: "idle",
      rate: 1,
      textDigest: null,
      currentTime: 0,
      duration: 0,
      previewingKey: KEY_A,
    });
    await refreshing;

    expect(usePlayerStore.getState().hydrated).toBe(true);
    expect(usePlayerStore.getState().previewingKey).toBeNull();
  });
});
