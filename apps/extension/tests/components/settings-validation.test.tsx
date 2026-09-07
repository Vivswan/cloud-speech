import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { Settings } from "@/components/app/views/Settings";
import { sendToBackground } from "@/lib/protocol";
import type { ProviderValidationResult } from "@/lib/provider-validation";

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

describe("Save & test outcomes", () => {
  beforeEach(() => {
    fakeBrowser.reset();
    vi.mocked(sendToBackground).mockReset();
  });

  it("a rejected draft shows the failure and its detail, and keeps the draft", async () => {
    const input = await saveAndTest({ ok: false, code: "unknown", detail: "HTTP 500" });

    expect(screen.getByText("settings.validation_unknown")).toBeInTheDocument();
    expect(screen.getByText("settings.validation_details")).toBeInTheDocument();
    expect(input.value).toBe("sk-draft");
    expect(vi.mocked(sendToBackground)).not.toHaveBeenCalledWith("scanVoices", expect.anything());
  });

  it("a draft overtaken by a newer Save & test shows nothing and keeps the draft", async () => {
    const input = await saveAndTest({ ok: false, code: "superseded" });

    // Not even an empty banner: nothing styled as a failure renders.
    expect(document.querySelector(".text-danger")).toBeNull();
    expect(input.value).toBe("sk-draft");
    expect(vi.mocked(sendToBackground)).not.toHaveBeenCalledWith("scanVoices", expect.anything());
  });

  it("a proven draft clears the inputs' draft state and reports the scan", async () => {
    await saveAndTest({ ok: true });

    expect(screen.getByText("settings.scan_ok")).toBeInTheDocument();
    expect(document.querySelector(".text-danger")).toBeNull();
    expect(vi.mocked(sendToBackground)).toHaveBeenCalledWith("scanVoices", {
      providerId: "openai",
    });
  });
});
