import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { BackupSection } from "@/components/app/settings/BackupSection";
import { EXPORT_APP_ID } from "@/lib/settings-transfer";
import { DEFAULT_SETTINGS, setSettings } from "@/lib/storage";
import { SETTINGS_VERSION } from "@/migrations/ladder";

// The field names the user reads are the salvage result itself, so the panel
// is read as shipped English, not as key names.
vi.mock("@/lib/i18n-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n-runtime")>()),
  ...(await import("../helpers/en-locale")).englishRuntime(),
}));

const unknownKeys = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [`extra${String(i + 1).padStart(2, "0")}`, i]),
);

describe("the import confirm panel", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.restoreAllMocks();
    await setSettings(DEFAULT_SETTINGS);
  });

  it.each([
    [
      "a corrupt known field and an unknown key, both by name",
      { speed: "corrupt", speeed: 2 },
      "These fields could not be read and will be skipped: speed, speeed",
    ],
    [
      "the first ten of many lost fields, the rest as a count",
      { speed: "corrupt", ...unknownKeys },
      "These fields could not be read and will be skipped: speed, extra01, extra02, extra03, extra04, extra05, extra06, extra07, extra08, extra09, and 3 more",
    ],
  ])("names %s", async (_case, lost, sentence) => {
    const { container } = render(<BackupSection settings={DEFAULT_SETTINGS} />);
    await screen.findByText("Import");
    const input = container.querySelector<HTMLInputElement>('input[type="file"]');
    if (!input) throw new Error("no file input");

    const file = JSON.stringify({
      app: EXPORT_APP_ID,
      version: SETTINGS_VERSION,
      exportedAt: "2026-08-05T12:00:00.000Z",
      settings: { ...DEFAULT_SETTINGS, ...lost },
    });
    fireEvent.change(input, { target: { files: [new File([file], "settings.json")] } });

    const panel = await screen.findByRole("group");
    expect(panel).toHaveTextContent(sentence);
  });
});
