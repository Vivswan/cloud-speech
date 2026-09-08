import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { BackupSection } from "@/components/app/settings/BackupSection";
import { Preferences } from "@/components/app/views/Preferences";
import { parseImport } from "@/lib/settings-transfer";
import { DEFAULT_SETTINGS, setSettings, voicesSessionItem } from "@/lib/storage";
import type { NormalizedVoice } from "@/providers/types";

// The two views that report a failure of their own through the shared
// notice: an import that never parsed, and a settings write storage refused.
// Both must read as the same two-part notice with the raw text behind
// Details, not as a bare line.

const joanna: NormalizedVoice = {
  id: "Joanna",
  providerId: "polly",
  displayName: "Joanna",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
};

const pollySelected = {
  ...DEFAULT_SETTINGS,
  perProvider: {
    polly: {
      credentials: { accessKeyId: "a", secretAccessKey: "s", region: "us-east-1" },
      verified: true,
      enabled: true,
    },
  },
  selection: { providerId: "polly", voiceId: "Joanna", model: "neural" },
};

/** The alert's Details, which must be collapsed and hold `detail`. */
function expectCollapsedDetails(notice: HTMLElement, detail: string) {
  const details = notice.querySelector("details");
  expect(details).not.toBeNull();
  expect(details).not.toHaveAttribute("open");
  expect(details).toHaveTextContent(detail);
}

describe("BackupSection", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    await setSettings(DEFAULT_SETTINGS);
  });

  it("shows a file that is not JSON as a notice: title, sentence, the parser's text behind Details", async () => {
    const { container } = render(<BackupSection />);
    await screen.findByText("settings.backup_import");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");

    const text = "not json at all";
    fireEvent.change(input, { target: { files: [new File([text], "settings.json")] } });

    const parsed = parseImport(text);
    if (parsed.ok) throw new Error("the parser accepted the file");
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.backup_import_failed_title");
    expect(notice).toHaveTextContent("settings.backup_import_not_json");
    expectCollapsedDetails(notice, parsed.detail);
  });

  it("the same bad file picked again is a new report: its Details start collapsed", async () => {
    const { container } = render(<BackupSection />);
    await screen.findByText("settings.backup_import");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");
    const pick = () =>
      fireEvent.change(input, {
        target: { files: [new File(["not json at all"], "settings.json")] },
      });

    pick();
    const first = (await screen.findByRole("alert")).querySelector("details");
    if (!first) throw new Error("the notice rendered no Details");
    first.open = true;

    pick();
    await waitFor(() => {
      const second = screen.getByRole("alert").querySelector("details");
      expect(second).not.toBe(first);
      expect(second?.open).toBe(false);
    });
  });
});

describe("Preferences", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    // fakeBrowser's commands.getAll throws "not implemented" synchronously.
    vi.spyOn(fakeBrowser.commands, "getAll").mockImplementation((() =>
      Promise.resolve([])) as never);
    await voicesSessionItem.setValue([joanna]);
    await fakeBrowser.storage.sync.set({ settings: pollySelected });
  });

  it("shows a write storage refused as a notice: title, sentence, the raw text behind Details", async () => {
    vi.spyOn(fakeBrowser.storage.sync, "set").mockRejectedValueOnce(
      new Error("QUOTA_BYTES quota exceeded"),
    );
    render(<Preferences />);

    const thumb = await screen.findByRole("slider", { name: "preferences.speed" });
    thumb.focus();
    fireEvent.keyDown(thumb, { key: "ArrowRight" });

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.storage_error_title");
    expect(notice).toHaveTextContent("settings.storage_error_quota");
    expectCollapsedDetails(notice, "Error: QUOTA_BYTES quota exceeded");
    await waitFor(() => expect(screen.getByRole("alert")).toBe(notice));
  });

  it("a second refused write with the same text is a new report: its Details start collapsed", async () => {
    const set = vi
      .spyOn(fakeBrowser.storage.sync, "set")
      .mockRejectedValue(new Error("QUOTA_BYTES quota exceeded"));
    render(<Preferences />);
    const thumb = await screen.findByRole("slider", { name: "preferences.speed" });
    thumb.focus();

    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    const first = (await screen.findByRole("alert")).querySelector("details");
    if (!first) throw new Error("the notice rendered no Details");
    first.open = true;

    fireEvent.keyDown(thumb, { key: "ArrowRight" });
    await waitFor(() => expect(set).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const second = screen.getByRole("alert").querySelector("details");
      expect(second).toHaveTextContent("Error: QUOTA_BYTES quota exceeded");
      expect(second).not.toBe(first);
      expect(second?.open).toBe(false);
    });
  });
});
