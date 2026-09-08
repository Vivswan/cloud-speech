import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Settings } from "@/components/app/views/Settings";
import { guideUrl } from "@/lib/guide";
import { sendToBackground } from "@/lib/protocol";
import { withProviderPrefs } from "@/lib/provider-state";
import type { ProviderValidationResult } from "@/lib/provider-validation";
import { DEFAULT_SETTINGS } from "@/lib/storage";
import { expectCollapsedDetails } from "../helpers/collapsed-details";

vi.mock("@/lib/protocol", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/protocol")>()),
  sendToBackground: vi.fn(),
}));

async function saveAndTest(reply: ProviderValidationResult): Promise<HTMLInputElement> {
  vi.mocked(sendToBackground).mockImplementation(async (id) => {
    if (id === "validateProvider") return reply;
    if (id === "scanVoices") return { familiesChecked: 1, familiesUnavailable: 0 };
    throw new Error(`unexpected request ${id}`);
  });
  render(<Settings />);
  fireEvent.click(await screen.findByText("providers.openai.name"));
  const input = await screen.findByLabelText<HTMLInputElement>("providers.openai.apiKey");
  fireEvent.change(input, { target: { value: "sk-draft" } });
  fireEvent.click(screen.getByText("settings.save_and_test"));
  await waitFor(() => expect(screen.getByText("settings.save_and_test")).toBeInTheDocument());
  return input;
}

/** OpenAI already proven with a working key, so a failed Save & test keeps
 *  it. Sync is on by default, so the blob lives in sync storage. */
async function seedVerifiedOpenai(): Promise<void> {
  await fakeBrowser.storage.sync.set({
    settings: {
      ...DEFAULT_SETTINGS,
      ...withProviderPrefs(DEFAULT_SETTINGS, "openai", {
        credentials: { apiKey: "sk-stored" },
        verified: true,
        enabled: true,
      }),
    },
  });
}

const OPENAI_GUIDE = guideUrl("setup/openai");

describe("Save & test outcomes", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.mocked(sendToBackground).mockReset();
  });

  it("a rejected draft shows the failure and its detail, and keeps the draft", async () => {
    const input = await saveAndTest({ ok: false, code: "unknown", detail: "HTTP 500" });

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("settings.validation_unknown_title");
    expect(notice).toHaveTextContent("settings.validation_unknown");
    const details = notice.querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("ValidationFailure(code=unknown): HTTP 500");
    expect(input.value).toBe("sk-draft");
    expect(vi.mocked(sendToBackground)).not.toHaveBeenCalledWith("scanVoices", expect.anything());
  });

  it("a draft overtaken by a newer Save & test shows nothing and keeps the draft", async () => {
    const input = await saveAndTest({ ok: false, code: "superseded" });

    // Not even an empty banner: nothing styled as a failure renders.
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".text-danger")).toBeNull();
    expect(input.value).toBe("sk-draft");
    expect(vi.mocked(sendToBackground)).not.toHaveBeenCalledWith("scanVoices", expect.anything());
  });

  it("a proven draft clears the inputs' draft state and reports the scan", async () => {
    await saveAndTest({ ok: true });

    expect(screen.getByText("settings.scan_ok")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.querySelector(".text-danger")).toBeNull();
    expect(vi.mocked(sendToBackground)).toHaveBeenCalledWith("scanVoices", {
      providerId: "openai",
    });
  });

  it.each([
    { state: "a verified provider", verified: true, kept: true },
    { state: "an unverified provider", verified: false, kept: false },
  ])("a failure over $state: previous credentials kept = $kept", async ({ verified, kept }) => {
    if (verified) await seedVerifiedOpenai();
    await saveAndTest({ ok: false, code: "authentication" });

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("settings.validation_authentication");
    expect(notice.textContent?.includes("settings.validation_kept")).toBe(kept);
  });

  it("the notice stays until the next attempt: it has no close button", async () => {
    await saveAndTest({ ok: false, code: "network" });

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent("settings.validation_network");
    expect(within(notice).queryByTitle("common.dismiss")).toBeNull();
  });

  it("a failed voice scan after a proven key is reported as a failed check", async () => {
    vi.mocked(sendToBackground).mockImplementation(async (id) => {
      if (id === "validateProvider") return { ok: true };
      throw new Error("scan exploded");
    });
    render(<Settings />);
    fireEvent.click(await screen.findByText("providers.openai.name"));
    fireEvent.change(await screen.findByLabelText("providers.openai.apiKey"), {
      target: { value: "sk-draft" },
    });
    fireEvent.click(screen.getByText("settings.save_and_test"));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.validation_unknown_title");
    expect(notice).toHaveTextContent("settings.scan_failed");
    expect(notice.querySelector("details")).toHaveTextContent("scan exploded");
  });
});

describe("each Save & test failure code", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.mocked(sendToBackground).mockReset();
  });

  const guided = [
    ["authentication", "settings.validation_authentication_title"],
    ["permission", "settings.validation_permission_title"],
    ["region", "settings.validation_region_title"],
  ] as const;

  it.each(guided)(
    "%s: title, sentence, detail, and a link to the setup guide",
    async (code, title) => {
      await saveAndTest({ ok: false, code, detail: `${code} detail` });

      const notice = screen.getByRole("alert");
      expect(notice).toHaveTextContent(title);
      // Exact: the title key starts with the message key, so a substring
      // match would accept an empty message.
      expect(
        within(notice).getByText(`settings.validation_${code}`, { exact: true }),
      ).toBeVisible();
      expect(notice.querySelector("details")).toHaveTextContent(`${code} detail`);
      expect(screen.getByRole("link", { name: "settings.validation_open_guide" })).toHaveAttribute(
        "href",
        OPENAI_GUIDE,
      );
    },
  );

  const unguided = [
    ["quota", "settings.validation_quota_title"],
    ["network", "settings.validation_network_title"],
    ["storage", "settings.validation_storage_title"],
    ["unknown", "settings.validation_unknown_title"],
  ] as const;

  it.each(unguided)("%s: title, sentence, detail, and no guide link", async (code, title) => {
    await saveAndTest({ ok: false, code, detail: `${code} detail` });

    const notice = screen.getByRole("alert");
    expect(notice).toHaveTextContent(title);
    expect(within(notice).getByText(`settings.validation_${code}`, { exact: true })).toBeVisible();
    expect(notice.querySelector("details")).toHaveTextContent(`${code} detail`);
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("a Save & test whose request failed reports the request's error behind Details, in English", async () => {
    vi.mocked(sendToBackground).mockRejectedValue(new Error("Receiving end does not exist"));
    render(<Settings />);
    fireEvent.click(await screen.findByText("providers.openai.name"));
    const input = await screen.findByLabelText<HTMLInputElement>("providers.openai.apiKey");
    fireEvent.change(input, { target: { value: "sk-draft" } });
    fireEvent.click(screen.getByText("settings.save_and_test"));

    const notice = await screen.findByRole("alert");
    expect(notice).toHaveTextContent("settings.validation_unknown_title");
    expect(within(notice).getByText("settings.validation_unknown", { exact: true })).toBeVisible();
    expectCollapsedDetails(
      notice,
      "ValidationFailure(code=unknown): validateProvider request failed: Error: Receiving end does not exist",
    );
    expect(input.value).toBe("sk-draft");
  });

  it("a failure without diagnostic text still names its class behind Details", async () => {
    await saveAndTest({ ok: false, code: "quota" });

    const details = screen.getByRole("alert").querySelector("details");
    expect(details).not.toHaveAttribute("open");
    expect(details).toHaveTextContent("ValidationFailure(code=quota): no diagnostic text");
  });
});
