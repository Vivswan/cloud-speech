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
});

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
  it("puts the refused write's own error text in the detail", () => {
    const refused = new SettingsNewerError(7);
    expect(describeNewerVersion(7).detail).toBe(String(refused));
    expect(describeNewerVersion(7).detail).toBe(describeWriteError(refused).detail);
    expect(describeNewerVersion(7).detail).toMatch(/^SettingsNewerError: /);
    expect(describeNewerVersion(7).detail).toContain("v7");
    expect(describeNewerVersion(7).detail).toContain(`v${SETTINGS_VERSION}`);
  });
});
