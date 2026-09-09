import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Settings } from "@/components/app/views/Settings";
import { guideUrl } from "@/lib/guide";
import { sendToBackground } from "@/lib/protocol";
import type { ProviderValidationResult } from "@/lib/provider-validation";
import { expectCollapsedDetails } from "../helpers/collapsed-details";

vi.mock("@/lib/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protocol")>()),
  sendToBackground: vi.fn(),
}));

// The verdict's sentence and fix link are the ones the read banner shows for
// the same failure, so they are read as shipped English, not as key names.
vi.mock("@/lib/i18n-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/i18n-runtime")>()),
  ...(await import("../helpers/en-locale")).englishRuntime(),
}));

const CONSOLE =
  "https://console.cloud.google.com/apis/api/texttospeech.googleapis.com/overview?project=42";
const GOOGLE_GUIDE = guideUrl("setup/google");

async function saveAndTestGoogle(reply: ProviderValidationResult): Promise<HTMLElement> {
  vi.mocked(sendToBackground).mockImplementation(async (id) => {
    if (id === "validateProvider") return reply;
    throw new Error(`unexpected request ${id}`);
  });
  render(<Settings />);
  fireEvent.click(await screen.findByText("Google Cloud TTS"));
  const input = await screen.findByLabelText<HTMLInputElement>("API Key");
  fireEvent.change(input, { target: { value: "EXAMPLE-google-key" } });
  fireEvent.click(screen.getByText("Save & test"));
  await waitFor(() => expect(screen.getByText("Save & test")).toBeInTheDocument());
  return screen.getByRole("alert");
}

describe("a Save & test verdict from the provider's own reading", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.mocked(sendToBackground).mockReset();
  });

  it("a disabled Google API: the code's title, the banner's sentence, and its fix link in place of the guide", async () => {
    const detail =
      "Google Cloud TTS voices failed: HTTP 403 (Cloud Text-to-Speech API has not been used in project 42 before or it is disabled.)";
    const notice = await saveAndTestGoogle({
      ok: false,
      code: "permission",
      detail,
      description: {
        kind: "api_disabled",
        feature: "Cloud Text-to-Speech API",
        actionUrl: CONSOLE,
      },
    });

    expect(notice).toHaveTextContent("No access");
    expect(
      within(notice).getByText(
        "This voice needs the Cloud Text-to-Speech API switched on in your Google Cloud TTS account. Turn it on, wait a minute, then try again.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      within(notice).queryByText("Give this key permission to use speech, then try again."),
    ).toBeNull();
    expect(
      screen.getByRole("link", { name: "Fix it on the Google Cloud TTS website" }),
    ).toHaveAttribute("href", CONSOLE);
    expect(
      screen.queryByRole("link", { name: "Open the Google Cloud TTS setup guide" }),
    ).toBeNull();
    expectCollapsedDetails(notice, `ValidationFailure(code=permission): ${detail}`);
  });

  it("disabled billing: the reading's own sentence", async () => {
    const notice = await saveAndTestGoogle({
      ok: false,
      code: "permission",
      detail:
        "Google Cloud TTS voices failed: HTTP 403 (This API method requires billing to be enabled.)",
      description: {
        kind: "api_disabled",
        messageKey: "errors.billing_disabled_message",
        actionUrl: "https://console.developers.google.com/billing/enable?project=42",
      },
    });

    expect(notice).toHaveTextContent("No access");
    expect(
      within(notice).getByText(
        "Your Google Cloud TTS account needs billing switched on. Turn it on, wait a minute, then try again.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Fix it on the Google Cloud TTS website" }),
    ).toHaveAttribute("href", "https://console.developers.google.com/billing/enable?project=42");
  });

  it("a reading with a sentence but no page keeps the guide link", async () => {
    const notice = await saveAndTestGoogle({
      ok: false,
      code: "permission",
      detail: "AccessDeniedException: HTTP 403: AccessDeniedException",
      description: { kind: "key_rejected", messageKey: "errors.permission_denied_message" },
    });

    expect(notice).toHaveTextContent("No access");
    expect(
      within(notice).getByText(
        "Your Google Cloud TTS key is not allowed to use speech. Give it permission in your Google Cloud TTS account, or pick a voice from another provider.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open the Google Cloud TTS setup guide" }),
    ).toHaveAttribute("href", GOOGLE_GUIDE);
  });

  it("without a reading the code's own advice and guide link stand", async () => {
    const notice = await saveAndTestGoogle({ ok: false, code: "permission", detail: "HTTP 403" });

    expect(notice).toHaveTextContent("No access");
    expect(
      within(notice).getByText("Give this key permission to use speech, then try again.", {
        exact: true,
      }),
    ).toBeVisible();
    expect(
      screen.getByRole("link", { name: "Open the Google Cloud TTS setup guide" }),
    ).toHaveAttribute("href", GOOGLE_GUIDE);
  });
});
