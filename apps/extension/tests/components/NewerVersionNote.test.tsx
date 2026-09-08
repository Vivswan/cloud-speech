import { chromeListing, firefoxListing } from "@cloud-speech/constants";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { NewerVersionNote } from "@/components/app/NewerVersionNote";
import { SETTINGS_VERSION } from "@/lib/storage";

describe("NewerVersionNote", () => {
  it("renders the lock as a two-part notice: title, sentence, store link, versions behind Details", () => {
    render(<NewerVersionNote storedVersion={SETTINGS_VERSION + 1} />);
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent("settings.storage_error_newer_title");
    // Exact: the title key starts with the message key.
    expect(within(note).getByText("settings.storage_error_newer", { exact: true })).toBeVisible();
    const listing = import.meta.env.FIREFOX ? firefoxListing : chromeListing;
    const link = screen.queryByRole("link", { name: "settings.storage_error_newer_action" });
    if (listing.status === "published") expect(link).toHaveAttribute("href", listing.url);
    else expect(link).toBeNull();
    const details = note.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent(`v${SETTINGS_VERSION + 1}`);
    expect(details).toHaveTextContent(`v${SETTINGS_VERSION}`);
  });

  it("is a state, not a failure: a polite status in the note palette, no close button", () => {
    render(<NewerVersionNote />);
    expect(screen.queryByRole("alert")).toBeNull();
    const note = screen.getByRole("status");
    expect(note.className).toContain("bg-note");
    expect(note.className).not.toContain("bg-danger-surface");
    expect(screen.queryByTitle("common.dismiss")).toBeNull();
    expect(note.querySelector("details")).toBeNull();
  });
});
