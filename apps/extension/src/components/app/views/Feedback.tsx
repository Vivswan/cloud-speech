import {
  GITHUB_ISSUES_URL,
  GITHUB_NEW_ISSUE_URL,
  INSTALL_SOURCES,
  PROVIDER_NAMES,
} from "@cloud-speech/constants";
import { Bug, Lightbulb, Star } from "lucide-react";
import { browser } from "#imports";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";
import { getLastReportedError } from "@/lib/background-error";
import { i18n } from "@/lib/i18n-runtime";
import { reviewUrl } from "@/lib/listing";

// PROVIDER_NAMES and INSTALL_SOURCES values are kept verbatim-equal to the
// dropdown options in .github/ISSUE_TEMPLATE/bug_report.yml; GitHub only
// prefills a dropdown when the query value equals an option (a vitest
// enforces the coupling).

/** "Chrome 120.0.6099.109" / "Firefox 128.0", or undefined when the user
 *  agent hides the version. */
function browserEnvironment(): string | undefined {
  const ua = import.meta.env.FIREFOX
    ? { name: "Firefox", pattern: /Firefox\/([\d.]+)/ }
    : { name: "Chrome", pattern: /Chrome\/([\d.]+)/ };
  const version = ua.pattern.exec(navigator.userAgent)?.[1];
  return version ? `${ua.name} ${version}` : undefined;
}

function installSource(): string {
  if (import.meta.env.FIREFOX) return INSTALL_SOURCES.firefox;
  // Store installs carry an update_url; unpacked dev builds don't.
  return browser.runtime.getManifest().update_url ? INSTALL_SOURCES.chrome : INSTALL_SOURCES.source;
}

/** Everything the extension already knows about the environment, keyed by the
 *  bug report form's field ids (.github/ISSUE_TEMPLATE/bug_report.yml), so the
 *  user doesn't fill it in by hand. GitHub drops keys that match no field. */
function bugReportFields(): Record<string, string> {
  const fields: Record<string, string> = {
    version: browser.runtime.getManifest().version,
    listing: installSource(),
  };
  const environment = browserEnvironment();
  if (environment) fields.environment = environment;
  // The failure being reported, not the selected provider: a Google preview
  // fails while Polly is selected. Without a failure the user picks the
  // provider in the form.
  const reported = getLastReportedError();
  const providerId = reported?.providerId;
  if (providerId) fields.provider = PROVIDER_NAMES[providerId];
  // The banner shows the failure in plain words; the maintainer needs the
  // raw text behind it. Labelled as what it is: the failure the user has in
  // mind may have been an inline one (Save & test, an import), which the
  // background never saw.
  if (reported) {
    fields.logs = `${i18n.t("feedback.last_background_error")}\n${reported.error.detail}`;
  }
  return fields;
}

function openIssue(template: string, fields: Record<string, string> = {}): void {
  const query = new URLSearchParams({ template, ...fields }).toString();
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
          <Button className="w-full" onClick={() => openIssue("bug_report.yml", bugReportFields())}>
            <Bug size={14} />
            {i18n.t("feedback.report_bug")}
          </Button>
          <Button className="w-full" onClick={() => openIssue("feature_request.yml")}>
            <Lightbulb size={14} />
            {i18n.t("feedback.request_feature")}
          </Button>
          <p className="text-xxs text-faint">
            {/* Schemeless: caption prose, not a link. */}
            {i18n.t("feedback.opens_github", [GITHUB_ISSUES_URL.replace(/^https:\/\//, "")])}
          </p>
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
