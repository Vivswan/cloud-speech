import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { usePlayback } from "@/hooks/usePlayback";
import { usePreview } from "@/hooks/usePreview";
import type { Playback } from "@/lib/playback";
import type { VoiceModelRef } from "@/lib/storage";

// The hooks are driven as the extension drives them: storage.session writes from another context, seen through the item watchers.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function Probe({ read }: { read: () => unknown }) {
  return <output>{JSON.stringify(read())}</output>;
}

let container: HTMLElement;
let root: Root;

async function mount(read: () => unknown): Promise<() => unknown> {
  await act(async () => {
    root.render(<Probe read={read} />);
  });
  return () => {
    const output = container.querySelector("output");
    if (!output) throw new Error("the probe did not render");
    return JSON.parse(output.textContent);
  };
}

/** Every storage.session read snapshots its value at once but answers only after `release`, so a watched
 *  change can land while the mount read is in flight and the read still carries the old value. */
function gateSessionReads(): () => void {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const get = fakeBrowser.storage.session.get.bind(fakeBrowser.storage.session);
  fakeBrowser.storage.session.get = async (...args: unknown[]) => {
    const snapshot = await (get as (...a: unknown[]) => Promise<unknown>)(...args);
    await gate;
    return snapshot;
  };
  return release;
}

const PLAYING: Playback = {
  status: "playing",
  epoch: 2,
  rate: 1.5,
  textDigest: "abc:12",
  currentTime: 4,
  duration: 30,
};
const JOANNA: VoiceModelRef = { providerId: "polly", voiceId: "Joanna", model: "neural" };

beforeEach(() => {
  fakeBrowser.reset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
});

describe("usePlayback", () => {
  it("is null until the document was read, then follows every write", async () => {
    await fakeBrowser.storage.session.set({ playback: PLAYING });
    const value = await mount(() => usePlayback());
    expect(value()).toEqual(PLAYING);

    await act(async () => {
      await fakeBrowser.storage.session.set({ playback: { ...PLAYING, currentTime: 9 } });
    });
    expect(value()).toEqual({ ...PLAYING, currentTime: 9 });

    // A document the background never wrote reads as idle, not as null.
    await act(async () => {
      await fakeBrowser.storage.session.remove("playback");
    });
    expect(value()).toEqual({ status: "idle", epoch: 0, rate: 1 });
  });

  it("renders null before the first read settles", async () => {
    const release = gateSessionReads();

    const value = await mount(() => usePlayback());
    expect(value()).toBeNull();

    await act(async () => {
      release();
    });
    expect(value()).toEqual({ status: "idle", epoch: 0, rate: 1 });
  });
});

describe("usePreview", () => {
  it("follows the preview slot and treats a corrupt value as no preview", async () => {
    const value = await mount(() => usePreview());
    expect(value()).toBeNull();

    await act(async () => {
      await fakeBrowser.storage.session.set({ preview: JOANNA });
    });
    expect(value()).toEqual(JOANNA);

    await act(async () => {
      await fakeBrowser.storage.session.set({ preview: "garbage" });
    });
    expect(value()).toBeNull();
  });

  it("a preview that ended while the mount read was in flight stays ended", async () => {
    await fakeBrowser.storage.session.set({ preview: JOANNA });
    const release = gateSessionReads();
    const value = await mount(() => usePreview());

    // The slot clears before the gated read answers with the row it captured earlier.
    await act(async () => {
      await fakeBrowser.storage.session.set({ preview: null });
    });
    expect(value()).toBeNull();
    await act(async () => {
      release();
    });
    expect(value()).toBeNull();
  });
});
