import { chromeListing, firefoxListing } from "@cloud-speech/constants";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { describeNewerVersion, describeWriteError, useSettings } from "@/hooks/useSettings";
import {
  DEFAULT_SETTINGS,
  importBackupItem,
  setSettings,
  syncEnabledItem,
  updateSettingsWith,
} from "@/lib/settings/storage";
import { SettingsNewerError } from "@/migrations";
import { SETTINGS_VERSION } from "@/migrations/ladder";

vi.mock("@/lib/text/i18n-runtime", () => ({ i18n: { t: (key: string) => key } }));

describe("useSettings", () => {
  beforeEach(() => fakeBrowser.reset());
  afterEach(() => vi.restoreAllMocks());

  it("reports no newer version and applies writes on a current blob", async () => {
    await setSettings({ ...DEFAULT_SETTINGS, speed: 2 });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings).not.toBeNull());

    expect(result.current.newerVersion).toBeNull();
    await act(() => result.current.update({ speed: 3 }));
    await waitFor(() => expect(result.current.settings?.speed).toBe(3));
    expect(result.current.writeFailure).toBeNull();
  });

  it("exposes the newer version, keeps the settings readable, and explains a refused write", async () => {
    await fakeBrowser.storage.sync.set({
      settings: {
        ...DEFAULT_SETTINGS,
        schemaVersion: SETTINGS_VERSION + 1,
        speed: 3,
        laterField: "x",
      },
    });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings).not.toBeNull());

    expect(result.current.newerVersion).toBe(SETTINGS_VERSION + 1);
    expect(result.current.settings?.speed).toBe(3);

    await act(() => result.current.update({ speed: 4 }));
    await waitFor(() => expect(result.current.writeFailure).not.toBeNull());
    expect(result.current.settings?.speed).toBe(3);
    expect(result.current.writeFailure?.value).toMatchObject({
      title: "settings.storage_error_newer_title",
      message: "settings.storage_error_newer",
      detail: expect.stringContaining(`v${SETTINGS_VERSION + 1}`),
    });
  });

  it("clears the failure once a later write goes through", async () => {
    await setSettings({ ...DEFAULT_SETTINGS, speed: 2 });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    const original = fakeBrowser.storage.sync.set.bind(fakeBrowser.storage.sync);
    const set = vi
      .spyOn(fakeBrowser.storage.sync, "set")
      .mockRejectedValueOnce(new Error("QUOTA_BYTES quota exceeded"));

    await act(() => result.current.update({ speed: 3 }));
    await waitFor(() => expect(result.current.writeFailure).not.toBeNull());
    expect(result.current.writeFailure?.value.message).toBe("settings.storage_error_quota");

    set.mockImplementation(original);
    await act(() => result.current.update({ speed: 3 }));
    await waitFor(() => expect(result.current.writeFailure).toBeNull());
  });

  it.each([
    {
      entry: "this hook's toggle",
      flip: (hook: Hook) => hook.setSyncEnabled(true, { adoptRemote: true }),
    },
    {
      // Another popup or the background flips the flag: no write guard of this hook runs.
      entry: "a flag flip by another context",
      flip: () => syncEnabledItem.setValue(true),
    },
  ])(
    "$entry points at an unreadable synced area: the owner's report shows as a write failure, not a silent default",
    async ({ flip }) => {
      await syncEnabledItem.setValue(false);
      await fakeBrowser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, speed: 3 } });
      const { result } = renderHook(() => useSettings());
      await waitFor(() => expect(result.current.settings).not.toBeNull());
      expect(result.current.syncEnabled).toBe(false);

      // The flip itself goes through; every read of the synced area after it fails.
      failSyncReads(() => syncEnabledItem.getValue(), "every time");

      await act(() => flip(result.current));
      await waitFor(() => expect(result.current.writeFailure).not.toBeNull());
      expect(result.current.syncEnabled).toBe(true);
      expect(result.current.settings?.speed).toBe(DEFAULT_SETTINGS.speed);
      expect(result.current.writeFailure?.value).toMatchObject({
        message: "settings.storage_error_generic",
        detail: expect.stringContaining("disk full"),
      });
    },
  );

  it("the sync toggle goes through and the owner's first read of the new area fails: the report stays, the toggle's success does not erase it", async () => {
    await syncEnabledItem.setValue(false);
    await fakeBrowser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, speed: 3 } });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings).not.toBeNull());

    failSyncReads(() => syncEnabledItem.getValue(), "once");

    await act(() => result.current.setSyncEnabled(true, { adoptRemote: true }));
    await waitFor(() => expect(result.current.writeFailure).not.toBeNull());
    expect(result.current.syncEnabled).toBe(true);
    expect(result.current.settings?.speed).toBe(DEFAULT_SETTINGS.speed);
    expect(result.current.writeFailure?.value).toMatchObject({
      message: "settings.storage_error_generic",
      detail: expect.stringContaining("disk full"),
    });
  });

  it("a backup restore goes through and the owner's read-back of it fails: the report stays, the restore's success does not erase it", async () => {
    await setSettings({ ...DEFAULT_SETTINGS, speed: 2 });
    await importBackupItem.setValue({
      savedAt: "2024-01-01T00:00:00.000Z",
      settings: { ...DEFAULT_SETTINGS, speed: 3 },
    });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings?.speed).toBe(2));

    failSyncReads((stored) => stored.settings?.speed === 3, "once");

    await act(() => result.current.restoreBackup());
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toMatchObject({ speed: 3 });
    await waitFor(() => expect(result.current.writeFailure).not.toBeNull());
    expect(result.current.syncEnabled).toBe(true);
    expect(result.current.settings?.speed).toBe(2);
    expect(result.current.writeFailure?.value).toMatchObject({
      message: "settings.storage_error_generic",
      detail: expect.stringContaining("disk full"),
    });
  });

  it("a toggle that changes nothing (adopting over a flag another context already set) keeps the read failure and the stale settings until a real change is delivered", async () => {
    await syncEnabledItem.setValue(false);
    await fakeBrowser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, speed: 3 } });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings).not.toBeNull());

    // Another context enables sync while this popup's conflict prompt is open; the read fails once.
    failSyncReads(() => syncEnabledItem.getValue(), "once");
    await act(() => syncEnabledItem.setValue(true));
    await waitFor(() => expect(result.current.writeFailure).not.toBeNull());
    expect(result.current.settings?.speed).toBe(DEFAULT_SETTINGS.speed);

    // The user answers the prompt with "Use synced settings": the flag is already set, nothing is written.
    await act(() => result.current.setSyncEnabled(true, { adoptRemote: true }));
    expect(result.current.syncEnabled).toBe(true);
    expect(result.current.settings?.speed).toBe(DEFAULT_SETTINGS.speed);
    expect(result.current.writeFailure?.value).toMatchObject({
      message: "settings.storage_error_generic",
      detail: expect.stringContaining("disk full"),
    });

    await act(() => fakeBrowser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, speed: 4 } }));
    await waitFor(() => expect(result.current.settings?.speed).toBe(4));
    expect(result.current.writeFailure).toBeNull();
  });

  it("clearWriteError dismisses a rejected write's notice but leaves a read-back failure's notice, and the stale settings, until a record is delivered", async () => {
    await setSettings({ ...DEFAULT_SETTINGS, speed: 2 });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings?.speed).toBe(2));

    // Export clicked after this hook's write was refused: the notice belonged to that write.
    vi.spyOn(fakeBrowser.storage.sync, "set").mockRejectedValueOnce(
      new Error("QUOTA_BYTES quota exceeded"),
    );
    await act(() => result.current.update({ speed: 3 }));
    await waitFor(() =>
      expect(result.current.writeFailure?.value.message).toBe("settings.storage_error_quota"),
    );
    act(() => result.current.clearWriteError());
    expect(result.current.writeFailure).toBeNull();

    // Export clicked after another context's write whose read-back failed: the settings on
    // screen are still the old ones, and a click delivers no record.
    failSyncReads((stored) => stored.settings?.speed === 3, "once");
    await act(() => fakeBrowser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, speed: 3 } }));
    await waitFor(() =>
      expect(result.current.writeFailure?.value.message).toBe("settings.storage_error_generic"),
    );
    act(() => result.current.clearWriteError());
    expect(result.current.writeFailure?.value.message).toBe("settings.storage_error_generic");
    expect(result.current.settings?.speed).toBe(2);

    await act(() => fakeBrowser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, speed: 4 } }));
    await waitFor(() => expect(result.current.settings?.speed).toBe(4));
    expect(result.current.writeFailure).toBeNull();
  });

  it("the read on mount rejects: the notice shows over the beforeRead settings, nothing escapes as an unhandled rejection, and the next delivered record clears it", async () => {
    await setSettings({ ...DEFAULT_SETTINGS, speed: 2 });
    const escaped: unknown[] = [];
    const onRejection = (reason: unknown) => escaped.push(reason);
    failSyncReads(() => true, "once");
    process.on("unhandledRejection", onRejection);
    try {
      const { result } = renderHook(() => useSettings());
      await waitFor(() => expect(result.current.writeFailure).not.toBeNull());
      expect(result.current.settings).toBeNull();
      expect(result.current.newerVersion).toBeNull();
      expect(result.current.writeFailure?.value).toMatchObject({
        message: "settings.storage_error_generic",
        detail: expect.stringContaining("disk full"),
      });

      await act(() =>
        fakeBrowser.storage.sync.set({ settings: { ...DEFAULT_SETTINGS, speed: 4 } }),
      );
      await waitFor(() => expect(result.current.settings?.speed).toBe(4));
      expect(result.current.writeFailure).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(escaped).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
  });

  it("a rejected write's notice survives another context's successful write: the delivered record says nothing about the refused change", async () => {
    await setSettings({ ...DEFAULT_SETTINGS, speed: 2 });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.settings).not.toBeNull());
    vi.spyOn(fakeBrowser.storage.sync, "set").mockRejectedValueOnce(
      new Error("QUOTA_BYTES quota exceeded"),
    );

    await act(() => result.current.update({ speed: 3 }));
    await waitFor(() => expect(result.current.writeFailure).not.toBeNull());

    // The background reconciles a voice list and writes a pitch, as it does in normal operation.
    await act(() => updateSettingsWith(() => ({ pitch: 5 })));
    await waitFor(() => expect(result.current.settings?.pitch).toBe(5));
    expect(result.current.settings?.speed).toBe(2);
    expect(result.current.writeFailure?.value.message).toBe("settings.storage_error_quota");
  });
});

type Hook = ReturnType<typeof useSettings>;
type Stored = { settings?: { speed?: number } };

/** A write reads the area before it writes, so failing only the reads `isReadBack` accepts lets the
 *  write land while the read that would publish it fails. */
function failSyncReads(
  isReadBack: (stored: Stored) => boolean | Promise<boolean>,
  times: "once" | "every time",
): void {
  const original = fakeBrowser.storage.sync.get.bind(fakeBrowser.storage.sync) as (
    key: string,
  ) => Promise<Stored>;
  let failed = false;
  vi.spyOn(fakeBrowser.storage.sync, "get").mockImplementation(async (key) => {
    const stored = await original(key as string);
    if ((await isReadBack(stored)) && (times === "every time" || !failed)) {
      failed = true;
      throw new Error("disk full");
    }
    return stored;
  });
}

describe("describeWriteError", () => {
  const TITLE = "settings.storage_error_title";

  it.each([
    {
      failure: "a full sync quota",
      raw: "QUOTA_BYTES_PER_ITEM quota exceeded",
      message: "settings.storage_error_quota",
    },
    {
      failure: "a write burst",
      raw: "MAX_WRITE_OPERATIONS_PER_MINUTE exceeded",
      message: "settings.storage_error_rate",
    },
    {
      failure: "a sustained write burst",
      raw: "MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE",
      message: "settings.storage_error_rate",
    },
    {
      failure: "anything else",
      raw: "An unexpected error occurred",
      message: "settings.storage_error_generic",
    },
  ])("$failure: the notice says what to do, with the raw text as detail", ({ raw, message }) => {
    const error = new Error(raw);
    expect(describeWriteError(error)).toEqual({ title: TITLE, message, detail: String(error) });
  });

  it("a thrown empty string gets a detail saying so", () => {
    expect(describeWriteError("").detail).toBe("Error: the thrown value has no text");
    expect(describeWriteError("  \n").detail).toBe("Error: the thrown value has no text");
  });

  it("a thrown string is its own detail", () => {
    expect(describeWriteError("disk full")).toEqual({
      title: TITLE,
      message: "settings.storage_error_generic",
      detail: "disk full",
    });
  });

  it("a newer build's settings: the lock notice, its version in the detail and the store page as the action", () => {
    const payload = describeWriteError(new SettingsNewerError(SETTINGS_VERSION + 2));
    expect(payload.title).toBe("settings.storage_error_newer_title");
    expect(payload.message).toBe("settings.storage_error_newer");
    expect(payload.detail).toContain(`v${SETTINGS_VERSION + 2}`);
    // A listing still pending has no store page yet, so the notice offers no action.
    const listing = import.meta.env.FIREFOX ? firefoxListing : chromeListing;
    expect(payload.action).toEqual(
      listing.status === "published"
        ? { label: "settings.storage_error_newer_action", url: listing.url }
        : undefined,
    );
  });
});

describe("describeNewerVersion", () => {
  it("puts the refused write's own error text in the detail", () => {
    const refused = new SettingsNewerError(7);
    expect(describeNewerVersion(7).detail).toBe(String(refused));
    expect(describeNewerVersion(7).detail).toBe(describeWriteError(refused).detail);
    expect(describeNewerVersion(7).detail).toMatch(/^SettingsNewerError: /);
    expect(describeNewerVersion(7).detail).toContain("v7");
    expect(describeNewerVersion(7).detail).toContain(`v${SETTINGS_VERSION}`);
  });
});
