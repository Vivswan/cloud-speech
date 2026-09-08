import { chromeListing, firefoxListing } from "@cloud-speech/constants";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { describeNewerVersion, describeWriteError, useSettings } from "@/hooks/useSettings";
import { DEFAULT_SETTINGS, SETTINGS_VERSION, setSettings } from "@/lib/storage";
import { SettingsNewerError } from "@/migrations";

vi.mock("@/lib/i18n-runtime", () => ({ i18n: { t: (key: string) => key } }));

describe("useSettings", () => {
  beforeEach(() => fakeBrowser.reset());

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
    expect(result.current.writeFailure).toMatchObject({
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
    expect(result.current.writeFailure?.message).toBe("settings.storage_error_quota");

    set.mockImplementation(original);
    await act(() => result.current.update({ speed: 3 }));
    await waitFor(() => expect(result.current.writeFailure).toBeNull());
  });
});

describe("describeWriteError", () => {
  const raw = (text: string) => new Error(text);

  it("a full sync quota: the notice says what to remove, with the raw text as detail", () => {
    const error = raw("QUOTA_BYTES_PER_ITEM quota exceeded");
    expect(describeWriteError(error)).toEqual({
      title: "settings.storage_error_title",
      message: "settings.storage_error_quota",
      detail: String(error),
    });
  });

  it("a write burst: the notice says to wait", () => {
    expect(describeWriteError(raw("MAX_WRITE_OPERATIONS_PER_MINUTE exceeded"))).toMatchObject({
      title: "settings.storage_error_title",
      message: "settings.storage_error_rate",
    });
    expect(describeWriteError(raw("MAX_SUSTAINED_WRITE_OPERATIONS_PER_MINUTE"))).toMatchObject({
      message: "settings.storage_error_rate",
    });
  });

  it("anything else: a generic retry, never without the raw text", () => {
    expect(describeWriteError(raw("An unexpected error occurred"))).toEqual({
      title: "settings.storage_error_title",
      message: "settings.storage_error_generic",
      detail: "Error: An unexpected error occurred",
    });
    expect(describeWriteError("disk full")).toMatchObject({ detail: "disk full" });
  });

  it("a newer build's settings: the lock notice, its version in the detail and the store page as the action", () => {
    const payload = describeWriteError(new SettingsNewerError(SETTINGS_VERSION + 2));
    expect(payload.title).toBe("settings.storage_error_newer_title");
    expect(payload.message).toBe("settings.storage_error_newer");
    expect(payload.detail).toContain(`v${SETTINGS_VERSION + 2}`);
    // The link goes to the listing this build ships on; a listing that is
    // still pending has no page to link to, so the notice offers no action.
    const listing = import.meta.env.FIREFOX ? firefoxListing : chromeListing;
    expect(payload.action).toEqual(
      listing.status === "published"
        ? { label: "settings.storage_error_newer_action", url: listing.url }
        : undefined,
    );
  });
});

describe("describeNewerVersion", () => {
  it("names both versions in the detail only when the stored one is known", () => {
    expect(describeNewerVersion(7).detail).toBe(
      `Stored settings schema v7; this build writes v${SETTINGS_VERSION}`,
    );
    expect(describeNewerVersion().detail).toBeUndefined();
  });
});
