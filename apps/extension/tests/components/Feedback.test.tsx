import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GITHUB_NEW_ISSUE_URL, INSTALL_SOURCES, PROVIDER_NAMES } from "@cloud-speech/constants";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { parse } from "yaml";
import { z } from "zod";
import { Feedback, MAX_REPORT_DETAIL_URL_BYTES } from "@/components/app/views/Feedback";
import {
  clearBackgroundError,
  getLastReportedError,
  reportBackgroundError,
} from "@/lib/background-error";
import { DEFAULT_SETTINGS } from "@/lib/storage";

// GitHub prefills a new-issue form only from query keys that equal a field id
// in the template named by `template=`; any other key is silently dropped.
// The templates live outside the TypeScript graph, so this reads them.
const templatesDir = resolve(__dirname, "../../../../.github/ISSUE_TEMPLATE");

// The last-reported slot is module state without a reset; the one test that
// needs a popup that saw no failure overrides the read.
vi.mock("@/lib/background-error", { spy: true });

const IssueFormSchema = z.object({
  body: z.array(z.object({ id: z.string().optional() })),
});

function formFieldIds(template: string): string[] {
  const form = IssueFormSchema.parse(parse(readFileSync(resolve(templatesDir, template), "utf8")));
  return form.body.flatMap((field) => (field.id ? [field.id] : []));
}

const RAW_DETAIL = "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403";
// The prefilled logs say what they are: the last failure the background
// surfaced, which need not be the one the user is reporting.
const LOGS = `feedback.last_background_error\n${RAW_DETAIL}`;

const manifest: ReturnType<typeof fakeBrowser.runtime.getManifest> = {
  manifest_version: 3,
  name: "Cloud Speech",
  version: "2.3.4",
};
const target = import.meta.env.FIREFOX
  ? {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:128.0) Gecko/20100101 Firefox/128.0",
      environment: "Firefox 128.0",
      listing: INSTALL_SOURCES.firefox,
    }
  : {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.109 Safari/537.36",
      environment: "Chrome 120.0.6099.109",
      // No update_url in the manifest above: an unpacked build.
      listing: INSTALL_SOURCES.source,
    };

async function openedIssueUrl(button: string): Promise<URL> {
  const create = vi.spyOn(fakeBrowser.tabs, "create").mockReturnValue(undefined);
  render(<Feedback />);
  fireEvent.click(screen.getByText(button));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  return new URL(create.mock.calls[0]?.[0]?.url ?? "");
}

describe("Feedback issue links", () => {
  const originalUserAgent = navigator.userAgent;

  beforeEach(async () => {
    fakeBrowser.reset();
    vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue(manifest);
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: target.userAgent });
    await fakeBrowser.storage.sync.set({
      settings: {
        ...DEFAULT_SETTINGS,
        selection: { providerId: "polly", voiceId: "Joanna", model: "neural" },
      },
    });
    // The failure the user is reporting: a Google preview failed while Polly is selected. Its banner has dismissed
    // itself by now, and its raw detail and its provider must still reach the form.
    reportBackgroundError(
      { title: "Could not read aloud", message: "m", detail: RAW_DETAIL },
      "google",
    );
    clearBackgroundError();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    Object.defineProperty(navigator, "userAgent", { configurable: true, value: originalUserAgent });
  });

  it.each([
    {
      button: "feedback.report_bug",
      template: "bug_report.yml",
      fields: {
        version: manifest.version,
        listing: target.listing,
        environment: target.environment,
        provider: PROVIDER_NAMES.google,
        logs: LOGS,
      },
    },
    {
      button: "feedback.request_feature",
      template: "feature_request.yml",
      fields: {},
    },
  ])(
    "$button opens $template with every query key prefilling one of its fields",
    async ({ button, template, fields }) => {
      const url = await openedIssueUrl(button);

      expect(`${url.origin}${url.pathname}`).toBe(GITHUB_NEW_ISSUE_URL);
      expect(Object.fromEntries(url.searchParams)).toEqual({ template, ...fields });

      expect(existsSync(resolve(templatesDir, template)), `${template} exists`).toBe(true);
      const fieldIds = formFieldIds(template);
      for (const key of url.searchParams.keys()) {
        if (key === "template") continue;
        expect(fieldIds, `${template} declares a field with id "${key}"`).toContain(key);
      }
    },
  );

  it("attaches neither provider nor logs when no failure was seen", async () => {
    // Once: a lasting return value would outlive this test (restoreAllMocks does not undo a module spy's).
    vi.mocked(getLastReportedError).mockReturnValueOnce(null);

    const url = await openedIssueUrl("feedback.report_bug");

    expect(Object.fromEntries(url.searchParams)).toEqual({
      template: "bug_report.yml",
      version: manifest.version,
      listing: target.listing,
      environment: target.environment,
    });
  });

  describe("a detail too long for the new-issue URL", () => {
    // What URLSearchParams writes for a text: the budget is spent in this form.
    const encodedLength = (text: string) =>
      new URLSearchParams({ text }).toString().length - "text=".length;
    const MARKER =
      /\n\[detail truncated: (\d+) more characters; open Details in the extension for the full text\]$/;

    async function truncatedLogs(detail: string): Promise<{ head: string; omitted: number }> {
      reportBackgroundError({ title: "t", message: "m", detail }, "openai");
      clearBackgroundError();
      const url = await openedIssueUrl("feedback.report_bug");
      // GitHub refuses a request line above roughly 8 KB with 414.
      expect(url.href.length).toBeLessThan(8000);
      const logs = url.searchParams.get("logs") ?? "";
      const marker = MARKER.exec(logs);
      expect(marker, "the marker line ends the logs").not.toBeNull();
      const body = logs.slice("feedback.last_background_error\n".length, marker?.index);
      return { head: body, omitted: Number(marker?.[1]) };
    }

    it.each([
      // A custom server's HTML error page: ASCII, but `<` and spaces encode to three and one characters.
      { name: "a 100 KB HTML page", detail: "<html><body>EXAMPLE error page ".repeat(4000) },
      // Nine encoded characters per code unit: a character cap of 2000 would still make an 18 KB URL.
      { name: "2000 CJK characters", detail: "\u4E2D".repeat(2000) },
    ])("carries the longest head of $name that fits and counts the rest", async ({ detail }) => {
      const { head, omitted } = await truncatedLogs(detail);

      expect(detail.startsWith(head)).toBe(true);
      expect(omitted).toBe(detail.length - head.length);
      // The longest head: one more character would go over the budget.
      expect(encodedLength(head)).toBeLessThanOrEqual(MAX_REPORT_DETAIL_URL_BYTES);
      expect(encodedLength(detail.slice(0, head.length + 1))).toBeGreaterThan(
        MAX_REPORT_DETAIL_URL_BYTES,
      );
    });

    it("keeps a detail whose encoding is exactly the budget whole", async () => {
      const detail = "x".repeat(MAX_REPORT_DETAIL_URL_BYTES);
      reportBackgroundError({ title: "t", message: "m", detail }, "openai");
      clearBackgroundError();

      const url = await openedIssueUrl("feedback.report_bug");

      expect(url.searchParams.get("logs")).toBe(`feedback.last_background_error\n${detail}`);
    });

    it("never cuts a surrogate pair in half", async () => {
      // An emoji (twelve encoded characters) sits where the budget has room for its lone high half (nine) but not for the pair.
      const room = MAX_REPORT_DETAIL_URL_BYTES - 10;
      const detail = `${"x".repeat(room)}\u{1F600}${"y".repeat(10)}`;

      const { head, omitted } = await truncatedLogs(detail);

      expect(head).toBe("x".repeat(room));
      expect(head).not.toContain("\uFFFD");
      expect(omitted).toBe(12);
    });
  });

  it("names no provider when the failure was attributed to none, whatever is selected", async () => {
    reportBackgroundError({ title: "Could not read aloud", message: "m", detail: RAW_DETAIL });
    clearBackgroundError();

    const url = await openedIssueUrl("feedback.report_bug");

    expect(Object.fromEntries(url.searchParams)).toEqual({
      template: "bug_report.yml",
      version: manifest.version,
      listing: target.listing,
      environment: target.environment,
      logs: LOGS,
    });
  });
});
