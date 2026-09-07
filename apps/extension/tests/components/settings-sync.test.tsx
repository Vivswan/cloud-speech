import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Settings } from "@/components/app/views/Settings";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, syncEnabledItem } from "@/lib/storage";

const local = { ...DEFAULT_SETTINGS, speed: 1.5 };
/** Same known fields as `local`, saved by a newer build. */
const newerRemote = { ...local, schemaVersion: SETTINGS_VERSION + 1, laterField: "x" };
const differentRemote = { ...local, speed: 2 };

/** Sync off, `local` in local storage, `remote` already synced by another device. */
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
