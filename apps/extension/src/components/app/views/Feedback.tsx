import { GITHUB_NEW_ISSUE_URL, PROVIDER_NAMES } from "@cloud-speech/constants";
import { Bug, Lightbulb, Star } from "lucide-react";
import { browser } from "#imports";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { i18n } from "@/lib/i18n-runtime";
import { reviewUrl } from "@/lib/listing";
import { getSettings } from "@/lib/storage";

// PROVIDER_NAMES values are kept verbatim-equal to the dropdown options in
// .github/ISSUE_TEMPLATE/bug_report.yml; GitHub only prefills a dropdown
// when the query value equals an option (a vitest enforces the coupling).

function browserVersion(): string {
  const pattern = import.meta.env.FIREFOX ? /Firefox\/([\d.]+)/ : /Chrome\/([\d.]+)/;
  return pattern.exec(navigator.userAgent)?.[1] ?? "";
}

function installSource(): string {
  if (import.meta.env.FIREFOX) return "Firefox Add-ons";
  // Store installs carry an update_url; unpacked dev builds don't.
  return browser.runtime.getManifest().update_url ? "Chrome Web Store" : "Built from source";
}

/** Everything the extension already knows about the environment, keyed by the
 *  issue-form field ids, so the user doesn't fill it in by hand. Params
 *  without a matching field (the feature template) are ignored by GitHub. */
async function environmentParams(): Promise<Record<string, string>> {
  const params: Record<string, string> = {
    version: browser.runtime.getManifest().version,
    listing: installSource(),
  };
  const version = browserVersion();
  if (version) params["browser-version"] = version;
  const providerId = (await getSettings().catch(() => null))?.selectedVoice?.providerId;
  const provider = providerId ? PROVIDER_NAMES[providerId] : undefined;
  if (provider) params.provider = provider;
  return params;
}

async function openIssue(params: Record<string, string>): Promise<void> {
  const query = new URLSearchParams({ ...(await environmentParams()), ...params }).toString();
  void browser.tabs.create({ url: `${GITHUB_NEW_ISSUE_URL}?${query}` });
}

export function Feedback() {
  const storeReviewUrl = reviewUrl();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionTitle>{i18n.t("feedback.title")}</SectionTitle>
        <Card className="flex flex-col gap-3">
          <p className="text-xs text-body">{i18n.t("feedback.description")}</p>
          <Button className="w-full" onClick={() => void openIssue({ template: "bug_report.yml" })}>
            <Bug size={14} />
            {i18n.t("feedback.report_bug")}
          </Button>
          <Button
            className="w-full"
            onClick={() => void openIssue({ template: "feature_request.yml" })}
          >
            <Lightbulb size={14} />
            {i18n.t("feedback.request_feature")}
          </Button>
          <p className="text-xxs text-faint">{i18n.t("feedback.opens_github")}</p>
          {storeReviewUrl && (
            <>
              <Button
                className="w-full"
                onClick={() => void browser.tabs.create({ url: storeReviewUrl })}
              >
                <Star size={14} />
                {i18n.t("feedback.leave_review")}
              </Button>
              <p className="text-xxs text-faint">{i18n.t("feedback.opens_store")}</p>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
