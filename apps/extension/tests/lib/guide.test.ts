import { DEV_SITE_URL } from "@cloud-speech/constants";
import { describe, expect, it } from "vitest";
import { guideUrl, homepageUrl, localizeGuideUrl } from "@/lib/guide";

// Vitest runs with import.meta.env.DEV = true, so GUIDE_BASE is DEV_SITE_URL.

describe("guide URLs", () => {
  it("localizes guide URLs into the mirrored locale trees", () => {
    const url = guideUrl("setup/polly");
    expect(url).toBe(`${DEV_SITE_URL}setup/polly/`);
    expect(localizeGuideUrl(url, "hi")).toBe(`${DEV_SITE_URL}hi/setup/polly/`);
    expect(localizeGuideUrl(url, "zh_CN")).toBe(`${DEV_SITE_URL}zh-cn/setup/polly/`);
    expect(localizeGuideUrl(url, "zh_TW")).toBe(`${DEV_SITE_URL}zh-tw/setup/polly/`);
    // English is the unprefixed tree.
    expect(localizeGuideUrl(url, "en")).toBe(url);
  });

  it("passes non-guide URLs through untouched", () => {
    const console = "https://console.aws.amazon.com/iam/";
    expect(localizeGuideUrl(console, "hi")).toBe(console);
  });

  it("homepage carries the locale prefix", () => {
    expect(homepageUrl()).toBe(DEV_SITE_URL);
    expect(homepageUrl("zh_TW")).toBe(`${DEV_SITE_URL}zh-tw/`);
  });
});
