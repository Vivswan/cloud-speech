import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { BackupSection } from "@/components/app/settings/BackupSection";
import { Preferences } from "@/components/app/views/Preferences";
import { Settings } from "@/components/app/views/Settings";
import {
  buildExport,
  MAX_IMPORT_FILE_BYTES,
  parseImport,
  serializeExport,
} from "@/lib/settings/settings-transfer";
import {
  DEFAULT_SETTINGS,
  estimateSyncSizeBytes,
  SYNC_QUOTA_BYTES_PER_ITEM,
  setSettings,
  voiceIssuesItem,
  voicesSessionItem,
} from "@/lib/settings/storage";
import type { NormalizedVoice } from "@/providers/types";
import { expectCollapsedDetails } from "../helpers/collapsed-details";

const joanna: NormalizedVoice = {
  id: "Joanna",
  providerId: "polly",
  displayName: "Joanna",
  languageCodes: ["en-US"],
  gender: "Female",
  models: ["neural"],
};

const matthew: NormalizedVoice = {
  ...joanna,
  id: "Matthew",
  displayName: "Matthew",
  gender: "Male",
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

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

describe("BackupSection", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    await setSettings(DEFAULT_SETTINGS);
  });

  it("shows a file that is not JSON as a notice: title, sentence, the parser's text behind Details", async () => {
    const { container } = render(<BackupSection settings={DEFAULT_SETTINGS} />);
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

  it("a file over the import cap is refused with its size behind Details", async () => {
    const { container } = render(<BackupSection settings={DEFAULT_SETTINGS} />);
    await screen.findByText("settings.backup_import");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");

    const oversized = new File([new Uint8Array(MAX_IMPORT_FILE_BYTES + 1)], "settings.json");
    fireEvent.change(input, { target: { files: [oversized] } });

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.backup_import_failed_title");
    expect(notice).toHaveTextContent("settings.backup_file_too_large");
    expectCollapsedDetails(
      notice,
      `ImportFileTooLarge: ${MAX_IMPORT_FILE_BYTES + 1} bytes > MAX_IMPORT_FILE_BYTES ${MAX_IMPORT_FILE_BYTES}`,
    );
  });

  it("an import too large to sync is refused at confirm with the estimate behind Details", async () => {
    const imported = {
      ...DEFAULT_SETTINGS,
      favorites: Array.from({ length: 400 }, (_, i) => `polly:EXAMPLE-favorite-${i}`),
    };
    const size = estimateSyncSizeBytes(imported);
    expect(size).toBeGreaterThan(SYNC_QUOTA_BYTES_PER_ITEM);
    const { container } = render(<BackupSection settings={DEFAULT_SETTINGS} />);
    await screen.findByText("settings.backup_import");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");

    const text = serializeExport(buildExport(imported, new Date("2026-01-02T03:04:05Z")));
    fireEvent.change(input, { target: { files: [new File([text], "settings.json")] } });
    fireEvent.click(await screen.findByText("settings.backup_replace"));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.backup_import_failed_title");
    expect(notice).toHaveTextContent("settings.backup_import_too_large");
    expectCollapsedDetails(
      notice,
      `ImportTooLargeToSync: replace estimate ${size} bytes > QUOTA_BYTES_PER_ITEM ${SYNC_QUOTA_BYTES_PER_ITEM}`,
    );
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(DEFAULT_SETTINGS);
  });

  it("the same bad file picked again is a new report: its Details start collapsed", async () => {
    const { container } = render(<BackupSection settings={DEFAULT_SETTINGS} />);
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
    await voicesSessionItem.setValue([joanna, matthew]);
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

  it("a voice pick refused by storage: one notice, and no second write for the reconcile that follows a pick", async () => {
    const set = vi
      .spyOn(fakeBrowser.storage.sync, "set")
      .mockRejectedValue(new Error("QUOTA_BYTES quota exceeded"));
    render(<Preferences />);
    fireEvent.click(await screen.findByRole("button", { name: /Joanna/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Matthew/ }));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.storage_error_quota");
    await settle();
    expect(set).toHaveBeenCalledTimes(1);
    expect(screen.getAllByRole("alert")).toEqual([notice]);
  });

  it("a voice pick stored and the issues read for its reconcile refused: the storage notice, no reconcile write, nothing escapes unhandled", async () => {
    const escaped: unknown[] = [];
    const onRejection = (reason: unknown) => escaped.push(reason);
    process.on("unhandledRejection", onRejection);
    try {
      const set = vi.spyOn(fakeBrowser.storage.sync, "set");
      render(<Preferences />);
      fireEvent.click(await screen.findByRole("button", { name: /Joanna/ }));
      const matthewRow = await screen.findByRole("button", { name: /Matthew/ });
      // The picker's own issues read on mount has been issued; the next one is the pick's.
      vi.spyOn(voiceIssuesItem, "getValue").mockRejectedValueOnce(new Error("disk full"));
      fireEvent.click(matthewRow);

      const notice = await screen.findByRole("alert");
      expect(notice).toHaveTextContent("settings.storage_error_title");
      expect(notice).toHaveTextContent("settings.storage_error_generic");
      expectCollapsedDetails(notice, "Error: disk full");
      await settle();
      expect(set).toHaveBeenCalledTimes(1);
      expect((await fakeBrowser.storage.sync.get("settings")).settings).toMatchObject({
        selection: { providerId: "polly", voiceId: "Matthew" },
      });
      expect(escaped).toEqual([]);
    } finally {
      process.off("unhandledRejection", onRejection);
    }
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

describe.each([
  { view: "Settings", View: Settings, control: () => screen.queryAllByRole("switch") },
  { view: "Preferences", View: Preferences, control: () => screen.queryAllByRole("slider") },
])("$view before its first record", ({ View, control }) => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    vi.spyOn(fakeBrowser.commands, "getAll").mockImplementation((() =>
      Promise.resolve([])) as never);
    await voicesSessionItem.setValue([joanna]);
    await fakeBrowser.storage.sync.set({ settings: pollySelected });
  });

  it("the first read rejects: the notice is on screen with no controls, and a delivered record replaces it with the view", async () => {
    vi.spyOn(fakeBrowser.storage.sync, "get").mockRejectedValueOnce(new Error("disk full"));
    render(<View />);

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.storage_error_title");
    expect(notice).toHaveTextContent("settings.storage_error_generic");
    expectCollapsedDetails(notice, "Error: disk full");
    expect(control()).toEqual([]);

    await fakeBrowser.storage.sync.set({ settings: { ...pollySelected, speed: 1.5 } });
    await waitFor(() => expect(control()).not.toEqual([]));
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a provider row's Enabled switch", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    await fakeBrowser.storage.sync.set({ settings: pollySelected });
  });

  it("a refused write shows the storage notice once, in the row, outliving a credential edit, and the stored flag stays", async () => {
    render(<Settings />);
    fireEvent.click(await screen.findByText("providers.polly.name"));
    const row = screen.getByTestId("provider-polly");
    vi.spyOn(fakeBrowser.storage.sync, "set").mockRejectedValueOnce(
      new Error("QUOTA_BYTES quota exceeded"),
    );
    fireEvent.click(await within(row).findByRole("switch", { name: "settings.enabled" }));

    const notice = await within(row).findByRole("alert");
    expect(notice).toHaveTextContent("settings.storage_error_quota");
    expectCollapsedDetails(notice, "Error: QUOTA_BYTES quota exceeded");
    expect(screen.getAllByRole("alert")).toEqual([notice]);
    fireEvent.change(within(row).getByLabelText("providers.polly.region"), {
      target: { value: "us-west-2" },
    });
    expect(screen.getAllByRole("alert")).toEqual([notice]);
    expect((await fakeBrowser.storage.sync.get("settings")).settings).toEqual(pollySelected);
  });
});

describe("Settings sections with their own record read", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    await fakeBrowser.storage.sync.set({ settings: pollySelected });
  });

  it("the view's read lands and the backup section's own first read rejects: one notice, in that section, while an opened provider row shows its form fed by the view's record", async () => {
    const original = fakeBrowser.storage.sync.get.bind(fakeBrowser.storage.sync);
    let reads = 0;
    // The view mounts its sections only once it has a record, so the first synced read is the
    // view's and every later one belongs to the backup section.
    const get = vi.spyOn(fakeBrowser.storage.sync, "get").mockImplementation((key) => {
      reads += 1;
      return reads === 1 ? original(key as string) : Promise.reject(new Error("disk full"));
    });
    render(<Settings />);

    await screen.findByRole("switch", { name: "settings.sync_label" });
    expect(await screen.findByText("settings.backup_export")).toBeVisible();
    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.storage_error_generic");
    fireEvent.click(await screen.findByText("providers.polly.name"));
    const row = screen.getByTestId("provider-polly");
    expect(await within(row).findByText("settings.save_and_test")).toBeVisible();
    expect(screen.getAllByRole("alert")).toEqual([notice]);

    get.mockImplementation(original);
    await fakeBrowser.storage.sync.set({ settings: { ...pollySelected, speed: 1.5 } });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("settings.backup_export")).toBeVisible();
    expect(
      within(screen.getByTestId("provider-polly")).getByText("settings.save_and_test"),
    ).toBeVisible();
  });
});
