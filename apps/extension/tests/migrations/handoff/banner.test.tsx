import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { HandoffBanner } from "@/migrations/handoff/Banner";
import { handoffBannerItem } from "@/migrations/handoff/state";

vi.mock("@/lib/i18n-runtime", () => ({ i18n: { t: (key: string) => key } }));
vi.mock("@/lib/listing", () => ({ unifiedStoreUrl: () => "https://store.example/unified" }));
vi.mock("@/migrations/handoff/listing", () => ({ isLegacyInstall: () => true }));

describe("handoff banner after the settings moved", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
  });

  it("offers to remove this copy through Chrome's confirm dialog, and stays when that fails", async () => {
    await handoffBannerItem.setValue({ imported: true, dismissedAt: null });
    const uninstallSelf = vi
      .spyOn(fakeBrowser.management, "uninstallSelf")
      .mockRejectedValue(new Error("Extension is managed"));
    render(<HandoffBanner />);

    const remove = await screen.findByRole("button", { name: "migration.remove_extension" });
    expect(screen.getByText("migration.transferred")).toBeInTheDocument();
    fireEvent.click(remove);

    expect(uninstallSelf).toHaveBeenCalledWith({ showConfirmDialog: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("button", { name: "migration.remove_extension" })).toBeInTheDocument();
  });
});
