import { Bug, Lightbulb } from "lucide-react";
import { i18n } from "#i18n";
import { browser } from "#imports";
import { Button } from "@/components/ui/button";
import { Card, SectionTitle } from "@/components/ui/card";

const ISSUES_URL = "https://github.com/vivswan/cloud-speech-for-chrome/issues/new";

function openIssue(params: Record<string, string>): void {
  const query = new URLSearchParams(params).toString();
  void browser.tabs.create({ url: `${ISSUES_URL}?${query}` });
}

export function Feedback() {
  return (
    <div className="flex flex-col gap-5">
      <div>
        <SectionTitle>{i18n.t("feedback.title")}</SectionTitle>
        <Card className="flex flex-col gap-3">
          <p className="text-xs text-stone-600">{i18n.t("feedback.description")}</p>
          <Button className="w-full" onClick={() => openIssue({ template: "bug_report.yml" })}>
            <Bug size={14} />
            {i18n.t("feedback.report_bug")}
          </Button>
          <Button className="w-full" onClick={() => openIssue({ template: "feature_request.yml" })}>
            <Lightbulb size={14} />
            {i18n.t("feedback.request_feature")}
          </Button>
          <p className="text-xxs text-stone-400">{i18n.t("feedback.opens_github")}</p>
        </Card>
      </div>
    </div>
  );
}
