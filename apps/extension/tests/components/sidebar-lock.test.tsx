import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Sidebar } from "@/components/app/Sidebar";
import { DEFAULT_SETTINGS } from "@/lib/storage";

const current = { ...DEFAULT_SETTINGS, theme: "system" as const };
const newer = { ...current, schemaVersion: 2, laterField: "x" };

function renderSidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe("sidebar theme toggle", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it("writable: one click cycles the stored theme", async () => {
    await fakeBrowser.storage.sync.set({ settings: current });
    renderSidebar();

    const toggle = screen.getByTitle("preferences.theme");
    await waitFor(() => expect(toggle).toBeEnabled());
    fireEvent.click(toggle);
    await waitFor(async () =>
      expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual({
        ...current,
        theme: "light",
      }),
    );
    expect(screen.getByTitle("preferences.theme")).toHaveTextContent("preferences.theme_light");
  });

  it("locked by a newer build's settings: disabled, the tooltip explains, a click writes nothing", async () => {
    await fakeBrowser.storage.sync.set({ settings: newer });
    const lock = vi.spyOn(navigator.locks, "request");
    renderSidebar();

    const toggle = await screen.findByTitle("settings.storage_error_newer");
    expect(toggle).toBeDisabled();
    expect(toggle).toHaveTextContent("preferences.theme_system");
    fireEvent.click(toggle);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(lock).not.toHaveBeenCalled();
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(newer);
  });
});
