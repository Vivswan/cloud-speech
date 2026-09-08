import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { GITHUB_NEW_ISSUE_URL, INSTALL_SOURCES, PROVIDER_NAMES } from "@cloud-speech/constants";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { parse } from "yaml";
import { z } from "zod";
import { Feedback } from "@/components/app/views/Feedback";
import { clearBackgroundError, reportBackgroundError } from "@/lib/background-error";
import { DEFAULT_SETTINGS } from "@/lib/storage";

// GitHub prefills a new-issue form only from query keys that equal a field id
// in the template named by `template=`; any other key is silently dropped.
// The templates live outside the TypeScript graph, so this reads them.
const templatesDir = resolve(__dirname, "../../../../.github/ISSUE_TEMPLATE");

const IssueFormSchema = z.object({
  body: z.array(z.object({ id: z.string().optional() })),
});

function formFieldIds(template: string): string[] {
  const form = IssueFormSchema.parse(parse(readFileSync(resolve(templatesDir, template), "utf8")));
  return form.body.flatMap((field) => (field.id ? [field.id] : []));
}

const RAW_DETAIL = "ProviderHttpError: Google Cloud TTS synthesis failed: HTTP 403";

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
    // The failure the user is reporting: its banner has dismissed itself by
    // now, and its raw detail must still reach the form.
    reportBackgroundError({ title: "Could not read aloud", message: "m", detail: RAW_DETAIL });
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
        provider: PROVIDER_NAMES.polly,
        logs: RAW_DETAIL,
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
});
