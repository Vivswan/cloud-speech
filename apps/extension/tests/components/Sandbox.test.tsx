import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Sandbox } from "@/components/app/views/Sandbox";
import { describeFailure } from "@/lib/errors";
import * as player from "@/lib/player-actions";
import { FailureReplyError, RequestTimeoutError, sendToBackground } from "@/lib/protocol";
import { DEFAULT_SETTINGS, setSettings } from "@/lib/storage";
import { NoVoiceSelectedError } from "@/lib/synthesize";
import { expectCollapsedDetails } from "../helpers/collapsed-details";

vi.mock("@/lib/player-actions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/player-actions")>()),
  play: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock("@/lib/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protocol")>()),
  sendToBackground: vi.fn(() => Promise.resolve(true)),
}));

const withVoice = {
  ...DEFAULT_SETTINGS,
  selection: { providerId: "polly" as const, voiceId: "Joanna", model: "neural" },
};

async function renderSandbox() {
  render(<Sandbox />);
  // The play button is enabled once the playback document has been read.
  const play = await screen.findByTitle("player.play");
  await waitFor(() => expect(play).toBeEnabled());
  return play;
}

describe("Sandbox notices", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.clearAllMocks();
    await setSettings(DEFAULT_SETTINGS);
  });

  it("no voice picked: the notice is what describeFailure says for NoVoiceSelectedError (no hand copy to drift), and no read is started", async () => {
    const play = await renderSandbox();
    fireEvent.click(play);

    const notice = await screen.findByRole("alert");
    const expected = describeFailure(new NoVoiceSelectedError("sandbox.no_voice"));
    expect(notice).toHaveTextContent(expected.title);
    // The sentence is pinned independently of describeFailure: the sandbox is inside the popup, so
    // its own key must reach the user, not the page toast's "open the popup" default.
    expect(within(notice).getByText("sandbox.no_voice", { exact: true })).toBeVisible();
    expectCollapsedDetails(notice, expected.detail);
    expect(player.play).not.toHaveBeenCalled();
  });

  it("empty text: names what is missing; typing clears the notice", async () => {
    await setSettings(withVoice);
    const play = await renderSandbox();
    const textarea = screen.getByLabelText("sandbox.textarea_label");
    fireEvent.change(textarea, { target: { value: "   " } });
    fireEvent.click(play);

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("sandbox.empty_text_title");
    expect(within(notice).getByText("sandbox.empty_text", { exact: true })).toBeVisible();
    expectCollapsedDetails(notice, "EmptyText: sandbox text is empty after trim");
    expect(player.play).not.toHaveBeenCalled();

    fireEvent.change(textarea, { target: { value: "Hello" } });
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });

  it("a download request that got no answer: the transport error in plain words with the raw text behind Details", async () => {
    await setSettings(withVoice);
    vi.mocked(sendToBackground).mockRejectedValueOnce(new Error("Receiving end does not exist"));
    await renderSandbox();
    fireEvent.click(screen.getByTitle("sandbox.download"));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("errors.download_failed_title");
    // The plain sentence up front; the raw transport text only behind Details.
    expect(within(notice).getByText("errors.unknown_message", { exact: true })).toBeVisible();
    expect(notice.querySelector("p")).not.toHaveTextContent("Receiving end does not exist");
    expect(notice.querySelector("details")).toHaveTextContent("Receiving end does not exist");
  });

  it("a download still running after the popup timeout is a note, not a failure: recognized by type, so a reworded message still is", async () => {
    await setSettings(withVoice);
    vi.mocked(sendToBackground).mockRejectedValueOnce(
      new RequestTimeoutError("download gave no answer within 120s"),
    );
    await renderSandbox();
    fireEvent.click(screen.getByTitle("sandbox.download"));

    const notice = await screen.findByRole("status");
    expect(screen.queryByRole("alert")).toBeNull();
    expect(notice.className).toContain("bg-note");
    expect(notice).toHaveTextContent("sandbox.download_timeout_title");
    expect(within(notice).getByText("sandbox.download_timeout", { exact: true })).toBeVisible();
    expectCollapsedDetails(
      notice,
      "DownloadTimeout: RequestTimeoutError: download gave no answer within 120s",
    );
  });

  it("a failure reply is not shown twice: the background already surfaced it", async () => {
    await setSettings(withVoice);
    vi.mocked(sendToBackground).mockRejectedValueOnce(new FailureReplyError("handler threw"));
    await renderSandbox();
    fireEvent.click(screen.getByTitle("sandbox.download"));

    await waitFor(() => expect(screen.getByTitle("sandbox.download")).toBeEnabled());
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Sandbox selection chip", () => {
  beforeEach(async () => {
    fakeBrowser.reset();
    vi.clearAllMocks();
    await setSettings(withVoice);
  });

  // A selection inside a child frame leaves the top document's selection empty: a chip fed by the
  // top frame alone would stay hidden over visibly selected text.
  it("a selection that lives in a child frame shows the chip and fills the text on use", async () => {
    // The open popup holds the focus, so no page frame reports it.
    const frames = [
      { result: { text: "", focused: false } },
      { result: { text: "Selected in the frame", focused: false } },
    ];
    Object.assign(fakeBrowser.tabs, { query: vi.fn(async () => [{ id: 4 }]) });
    Object.assign(fakeBrowser, {
      scripting: {
        // Like the browser: without allFrames only the top document answers.
        executeScript: vi.fn(async (injection: { target: { allFrames?: boolean } }) =>
          injection.target.allFrames ? frames : frames.slice(0, 1),
        ),
      },
    });
    await renderSandbox();

    const chip = await screen.findByText(/sandbox\.selection_prefix/);
    expect(chip).toHaveTextContent('sandbox.selection_prefix "Selected in the frame"');
    fireEvent.click(screen.getByText("sandbox.use_selection"));
    expect(screen.getByLabelText("sandbox.textarea_label")).toHaveValue("Selected in the frame");
  });
});
