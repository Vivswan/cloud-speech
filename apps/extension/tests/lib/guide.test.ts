import { DEV_SITE_URL } from "@cloud-speech/constants";
import { describe, expect, it } from "vitest";
import { guideUrl, homepageUrl } from "@/lib/guide";

// Vitest runs with import.meta.env.DEV = true, so GUIDE_BASE is DEV_SITE_URL.

describe("guide URLs", () => {
  it("builds guide URLs in the mirrored locale trees", () => {
    // English is the unprefixed default tree.
    expect(guideUrl("setup/polly")).toBe(`${DEV_SITE_URL}setup/polly/`);
    expect(guideUrl("setup/polly", "en")).toBe(`${DEV_SITE_URL}setup/polly/`);
    expect(guideUrl("setup/polly", "hi")).toBe(`${DEV_SITE_URL}hi/setup/polly/`);
    expect(guideUrl("setup/polly", "zh_CN")).toBe(`${DEV_SITE_URL}zh-cn/setup/polly/`);
    expect(guideUrl("setup/polly", "zh_TW")).toBe(`${DEV_SITE_URL}zh-tw/setup/polly/`);
  });

  it("homepage carries the locale prefix", () => {
    expect(homepageUrl()).toBe(DEV_SITE_URL);
    expect(homepageUrl("zh_TW")).toBe(`${DEV_SITE_URL}zh-tw/`);
  });
});
