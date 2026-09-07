import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { useSettings } from "@/hooks/useSettings";
import { DEFAULT_SETTINGS, setSettings } from "@/lib/storage";

vi.mock("@/lib/i18n-runtime", () => ({ i18n: { t: (key: string) => key } }));

describe("useSettings", () => {
  beforeEach(() => fakeBrowser.reset());

  it("reports no newer version and applies writes on a current blob", async () => {
    await setSettings({ ...DEFAULT_SETTINGS, speed: 2 });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.newerVersion).toBeNull();
    await act(() => result.current.update({ speed: 3 }));
    await waitFor(() => expect(result.current.settings?.speed).toBe(3));
    expect(result.current.writeError).toBe("");
  });

  it("exposes the newer version, keeps the settings readable, and explains a refused write", async () => {
    await fakeBrowser.storage.sync.set({
      settings: { ...DEFAULT_SETTINGS, schemaVersion: 2, speed: 3, laterField: "x" },
    });
    const { result } = renderHook(() => useSettings());
    await waitFor(() => expect(result.current.ready).toBe(true));

    expect(result.current.newerVersion).toBe(2);
    expect(result.current.settings?.speed).toBe(3);

    await act(() => result.current.update({ speed: 4 }));
    await waitFor(() => expect(result.current.writeError).toBe("settings.storage_error_newer"));
    expect(result.current.settings?.speed).toBe(3);
  });
});
