import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Settings } from "@/components/app/views/Settings";
import {
  DEFAULT_SETTINGS,
  estimateSyncSizeBytes,
  SYNC_QUOTA_BYTES_PER_ITEM,
  syncEnabledItem,
} from "@/lib/settings/storage";
import { SETTINGS_VERSION } from "@/migrations/ladder";
import { expectCollapsedDetails } from "../helpers/collapsed-details";

const local = { ...DEFAULT_SETTINGS, speed: 1.5 };
const newerRemote = { ...local, schemaVersion: SETTINGS_VERSION + 1, laterField: "x" };
const differentRemote = { ...local, speed: 2 };

/** Sync off on this device; `remote` was already synced by another device. */
async function seed(remote: object) {
  fakeBrowser.reset();
  vi.restoreAllMocks();
  await syncEnabledItem.setValue(false);
  await fakeBrowser.storage.local.set({ settings: local });
  await fakeBrowser.storage.sync.set({ settings: remote });
}

async function flipSyncOn() {
  render(<Settings />);
  fireEvent.click(await screen.findByRole("switch", { name: "settings.sync_label" }));
}

async function stored() {
  return {
    syncEnabled: await syncEnabledItem.getValue(),
    sync: (await fakeBrowser.storage.sync.get("settings")).settings,
    local: (await fakeBrowser.storage.local.get("settings")).settings,
  };
}

describe("enabling sync with settings too large for one sync item", () => {
  it("refuses with a two-part notice, the sizes behind Details, and leaves sync off", async () => {
    const oversized = {
      ...local,
      favorites: Array.from({ length: 400 }, (_, i) => `polly:EXAMPLE-favorite-${i}`),
    };
    const size = estimateSyncSizeBytes(oversized);
    expect(size).toBeGreaterThan(SYNC_QUOTA_BYTES_PER_ITEM);
    fakeBrowser.reset();
    vi.restoreAllMocks();
    await syncEnabledItem.setValue(false);
    await fakeBrowser.storage.local.set({ settings: oversized });
    await flipSyncOn();

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.storage_error_title");
    expect(notice).toHaveTextContent("settings.sync_too_large");
    expectCollapsedDetails(
      notice,
      `SyncTooLarge: settings estimate ${size} bytes > QUOTA_BYTES_PER_ITEM ${SYNC_QUOTA_BYTES_PER_ITEM}`,
    );
    expect(await stored()).toEqual({ syncEnabled: false, sync: undefined, local: oversized });
  });
});

describe("enabling sync when the synced copy cannot be read", () => {
  it("a rejected read: the storage notice shows and sync stays off, instead of a silent no-op", async () => {
    await seed(local);
    render(<Settings />);
    const toggle = await screen.findByRole("switch", { name: "settings.sync_label" });
    // Mounted and settled, so the next synced read is the conflict check alone.
    vi.spyOn(fakeBrowser.storage.sync, "get").mockRejectedValueOnce(new Error("disk full"));
    fireEvent.click(toggle);

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.storage_error_title");
    expect(notice).toHaveTextContent("settings.storage_error_generic");
    expectCollapsedDetails(notice, "Error: disk full");
    expect(screen.queryByText("settings.sync_conflict")).toBeNull();
    expect(await stored()).toEqual({ syncEnabled: false, sync: local, local });
  });
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** A storage call held open until the test settles it, for an action that must be overtaken first. */
type Peek = PromiseWithResolvers<Record<string, unknown>>;

describe("a peek overtaken by a second enable", () => {
  it.each([
    {
      stale: "rejects",
      settleStale: (held: Peek) => held.reject(new Error("disk full")),
    },
    {
      stale: "resolves with a differing copy",
      settleStale: (held: Peek) => held.resolve({ settings: differentRemote }),
    },
  ])(
    "the first peek $stale after the second click superseded it: it settles into nothing, and the second enable, queued behind it, goes through",
    async ({ settleStale }) => {
      await seed(local);
      render(<Settings />);
      const toggle = await screen.findByRole("switch", { name: "settings.sync_label" });
      await screen.findByText("settings.backup_export");
      const original = fakeBrowser.storage.sync.get.bind(fakeBrowser.storage.sync);
      const held: Peek = Promise.withResolvers();
      // The next synced read is the first peek's; it holds the write lock, so the second peek and
      // the enable after it wait behind it and land once it settles.
      vi.spyOn(fakeBrowser.storage.sync, "get").mockImplementationOnce(() => held.promise);
      fireEvent.click(toggle);
      vi.mocked(fakeBrowser.storage.sync.get).mockImplementation((key) => original(key as string));
      fireEvent.click(toggle);
      await settle();
      expect(await stored()).toEqual({ syncEnabled: false, sync: local, local });

      settleStale(held);
      await waitFor(async () =>
        expect(await stored()).toEqual({ syncEnabled: true, sync: local, local: undefined }),
      );
      await settle();
      expect(screen.queryByRole("alert")).toBeNull();
      expect(screen.queryByText("settings.sync_conflict")).toBeNull();
    },
  );
});

describe("an enable still settling when the switch is clicked Off", () => {
  it("the enable's last step rejects after the Off click superseded it: no notice, and the click's disable prompt opens over a committed move", async () => {
    await seed(local);
    render(<Settings />);
    const toggle = await screen.findByRole("switch", { name: "settings.sync_label" });
    // The enable's last step is the removal of the local copy; the flag has flipped by then, so the
    // switch already reads On, and the Off click's peek waits behind the move under the lock.
    const held = Promise.withResolvers<void>();
    vi.spyOn(fakeBrowser.storage.local, "remove").mockImplementationOnce(() => held.promise);
    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toBeChecked());
    fireEvent.click(toggle);
    held.reject(new Error("disk full"));

    expect(await screen.findByText("settings.sync_disable_warning")).toBeVisible();
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await stored()).toEqual({ syncEnabled: true, sync: local, local });
  });
});

describe("an adopt still reading its flag when the switch is clicked again", () => {
  it("the adopt's held read lands after the second click reopened the conflict prompt: sync stays off, so no On switch beside the prompt", async () => {
    await seed(differentRemote);
    render(<Settings />);
    const toggle = await screen.findByRole("switch", { name: "settings.sync_label" });
    await screen.findByText("settings.backup_export");
    fireEvent.click(toggle);
    const useSynced = await screen.findByText("settings.sync_use_synced");
    // The adopt's first step under the write lock is its read of the flag: the one local read in flight.
    const held = Promise.withResolvers<Record<string, unknown>>();
    const get = vi
      .spyOn(fakeBrowser.storage.local, "get")
      .mockImplementationOnce(() => held.promise);
    fireEvent.click(useSynced);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    fireEvent.click(toggle);
    held.resolve({ syncEnabled: false });

    // The second click's peek waited behind the adopt, which stopped before its first mutation.
    expect(await screen.findByText("settings.sync_conflict")).toBeVisible();
    await settle();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await stored()).toEqual({ syncEnabled: false, sync: differentRemote, local });
  });
});

describe("an adopt whose flag write is landing when the switch is clicked again", () => {
  it("the flag lands On, the second click opens no conflict prompt beside it, and the adopt completes: the local copy is gone", async () => {
    await seed(differentRemote);
    render(<Settings />);
    const toggle = await screen.findByRole("switch", { name: "settings.sync_label" });
    await screen.findByText("settings.backup_export");
    fireEvent.click(toggle);
    const useSynced = await screen.findByText("settings.sync_use_synced");
    // The adopt's first mutation is the flag flip, the one local write in flight; it was issued
    // before the second click, so it lands.
    const landing = Promise.withResolvers<void>();
    const original = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
    const set = vi.spyOn(fakeBrowser.storage.local, "set").mockImplementationOnce(async (items) => {
      await landing.promise;
      await original(items);
    });
    fireEvent.click(useSynced);
    await waitFor(() => expect(set).toHaveBeenCalledTimes(1));
    fireEvent.click(toggle);
    landing.resolve();

    await waitFor(() => expect(toggle).toBeChecked());
    await settle();
    expect(screen.queryByText("settings.sync_conflict")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await stored()).toEqual({ syncEnabled: true, sync: differentRemote, local: undefined });
  });
});

describe("a disable whose flag write is landing when the switch is clicked again", () => {
  it("the flag lands Off, the second click opens no disable prompt beside it, and the move completes: the synced copy is gone", async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    await fakeBrowser.storage.sync.set({ settings: local });
    render(<Settings />);
    const toggle = await screen.findByRole("switch", { name: "settings.sync_label" });
    await screen.findByText("settings.backup_export");
    fireEvent.click(toggle);
    fireEvent.click(await screen.findByText("common.continue"));
    // The disable's local writes are the copy, then the flag flip; the flip is the one held.
    const landing = Promise.withResolvers<void>();
    const original = fakeBrowser.storage.local.set.bind(fakeBrowser.storage.local);
    let writes = 0;
    const set = vi.spyOn(fakeBrowser.storage.local, "set").mockImplementation(async (items) => {
      writes += 1;
      if (writes === 2) await landing.promise;
      await original(items);
    });
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    landing.resolve();

    await waitFor(() => expect(toggle).not.toBeChecked());
    await settle();
    expect(screen.queryByText("settings.sync_disable_warning")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(await stored()).toEqual({ syncEnabled: false, sync: undefined, local });
  });
});

describe("enabling sync over an existing synced copy", () => {
  it("a newer copy with equal known fields: only adopting is offered, and it is lossless", async () => {
    await seed(newerRemote);
    await flipSyncOn();

    expect(await screen.findByText("settings.sync_conflict_newer")).toBeInTheDocument();
    expect(screen.queryByText("settings.sync_keep_local")).toBeNull();
    expect(screen.queryByText("settings.storage_error_newer")).toBeNull();
    expect(await stored()).toEqual({ syncEnabled: false, sync: newerRemote, local });

    fireEvent.click(screen.getByText("settings.sync_use_synced"));
    await waitFor(async () =>
      expect(await stored()).toEqual({ syncEnabled: true, sync: newerRemote, local: undefined }),
    );
    // Now reading the adopted newer copy: read-only until this device updates.
    expect(await screen.findByText("settings.storage_error_newer")).toBeInTheDocument();
  });

  it("a current copy with different fields: both copies are offered", async () => {
    await seed(differentRemote);
    await flipSyncOn();

    expect(await screen.findByText("settings.sync_conflict")).toBeInTheDocument();
    expect(screen.getByText("settings.sync_keep_local")).toBeInTheDocument();
    expect(screen.getByText("settings.sync_use_synced")).toBeInTheDocument();

    fireEvent.click(screen.getByText("settings.sync_keep_local"));
    await waitFor(async () =>
      expect(await stored()).toEqual({ syncEnabled: true, sync: local, local: undefined }),
    );
  });

  it("an identical current copy: no prompt, sync just turns on", async () => {
    await seed(local);
    await flipSyncOn();

    await waitFor(async () =>
      expect(await stored()).toEqual({ syncEnabled: true, sync: local, local: undefined }),
    );
    expect(screen.queryByText("settings.sync_conflict")).toBeNull();
    expect(screen.queryByText("settings.sync_conflict_newer")).toBeNull();
  });
});
